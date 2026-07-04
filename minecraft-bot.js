require('dotenv').config();

const EventEmitter = require('events');
const path = require('path');
const readline = require('readline');
const mineflayer = require('mineflayer');

const AUTH_CACHE_DIRECTORY = path.join(__dirname, '.minecraft-bot-auth');
const MIN_RECONNECT_DELAY_MINUTES = 5;
const MAX_RECONNECT_DELAY_MINUTES = 15;
const DEFAULT_PAYMENT_TIMEOUT_MS = 30_000;
const DEFAULT_BALANCE_COMMAND_TIMEOUT_MS = 8_000;
const DEFAULT_ALERT_COOLDOWN_MS = 15 * 60 * 1_000;
const MIN_CHAT_COMMAND_DELAY_MS = 250;
const MAX_PENDING_PAYMENT_RESPONSES = 5;
const DEFAULT_COBBLE_DIG_DISTANCE = 5;
const DEFAULT_COBBLE_IDLE_MS = 100;
const DEFAULT_COBBLE_ERROR_MS = 1_000;
const DEFAULT_COBBLE_SWING_MS = 300;
const DEFAULT_COBBLE_MIN_DIG_MS = 50;
const DEFAULT_COBBLE_USE_ITEM_MS = 250;
const DEFAULT_COBBLE_WIGGLE_TAP_MS = 250;
const DEFAULT_COBBLE_WIGGLE_GAP_MS = 100;
const COBBLE_LOOK_STRAIGHT_UP_PITCH = Math.PI / 2;
const COBBLE_WIGGLE_CONTROLS = ['left', 'right', 'forward', 'back'];
const DEFAULT_BALANCE_COMMANDS = ['/balance', '/money', '/bal'];
const DEFAULT_PAYMENT_SUCCESS_PATTERN =
    String.raw`\b(?:paid|sent|transferred)\b|\bpayment\b.*\b(?:complete|completed|successful|sent)\b`;
const DEFAULT_PAYMENT_FAILURE_PATTERN = [
    String.raw`\b(?:insufficient funds|(?:do not have |don't have )?enough (?:money|funds)|not enough (?:money|funds))\b`,
    String.raw`\b(?:player not found|unknown player|invalid (?:player|amount)|cannot pay|can't pay|payment failed|payment was not sent|usage:.*pay)\b`,
    String.raw`\b(?:could(?: not|n't) find|can(?:not|'t) find|no such player|no player(?: named)?|player does(?: not|n't) exist|user does(?: not|n't) exist)\b`,
    String.raw`\b(?:player is not online|player .* not online|has never joined|never joined before|not a valid (?:player|username)|invalid username)\b`
].join('|');
const DEFAULT_BALANCE_RESPONSE_PATTERN =
    String.raw`\b(?:balance|bal|money|cash)\b[^0-9$]*\$?\s*([\d,]+(?:\.\d+)?\s*[kmbt]?)|\$?\s*([\d,]+(?:\.\d+)?\s*[kmbt]?)\s*(?:is\s+)?(?:your\s+)?(?:balance|money|cash)\b|\byou\s+have\s+\$?\s*([\d,]+(?:\.\d+)?\s*[kmbt]?)\b`;
const DEFAULT_BALANCE_FAILURE_PATTERN =
    String.raw`\b(?:unknown command|command not found|unknown or incomplete command|invalid command|incorrect argument|usage:.*(?:bal|balance|money)|you do not have permission|no permission)\b`;

let bot = null;
let reconnectTimer = null;
let shuttingDown = false;
let pendingPayment = null;
let pendingBalance = null;
let lastSmsAlertAt = 0;
let lastPrivateMessage = null;
let lastIncomingPayment = null;
let chatCommandQueue = Promise.resolve();
let lastChatCommandAt = 0;
let minecraftOperationQueue = Promise.resolve();
let cobbleMode = null;
const minecraftEvents = new EventEmitter();

function sleep(ms) {
    return new Promise(resolve => {
        setTimeout(resolve, ms);
    });
}

function emitMinecraftEvent(title, message, level = 'info', details = {}) {
    minecraftEvents.emit('log', {
        title,
        message,
        level,
        details,
        timestamp: new Date().toISOString()
    });
}

function actionDetails(context = {}) {
    const details = {};

    if (context.actorTag) details['Discord user'] = context.actorTag;
    if (context.actorId) details['Discord ID'] = context.actorId;
    if (context.source) details.Source = context.source;

    return details;
}

function shouldSuppressPaymentLog(context = {}) {
    return Boolean(context.suppressPaymentLog);
}

function shouldDeferPaymentLog(context = {}) {
    return Boolean(context.deferPaymentLogUntilBalanceCheck);
}

function shouldEmitImmediatePaymentLog(context = {}) {
    return !shouldSuppressPaymentLog(context) && !shouldDeferPaymentLog(context);
}

function chatCommandDelayMs() {
    const delayMs = Number(
        process.env.MINECRAFT_CHAT_COMMAND_DELAY_MS ||
        MIN_CHAT_COMMAND_DELAY_MS
    );

    if (!Number.isInteger(delayMs) || delayMs < MIN_CHAT_COMMAND_DELAY_MS || delayMs > 60_000) {
        throw new Error(`MINECRAFT_CHAT_COMMAND_DELAY_MS must be between ${MIN_CHAT_COMMAND_DELAY_MS} and 60000.`);
    }

    return delayMs;
}

function parsePrivateMessage(message, botUsername = '') {
    const text = cleanMinecraftMessage(message);
    const escapedBotUsername = botUsername
        ? botUsername.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        : '[A-Za-z0-9_.]+';
    const patterns = [
        /^([A-Za-z0-9_.]{1,17}) whispers(?: to you)?:?\s+(.+)$/i,
        /^From\s+([A-Za-z0-9_.]{1,17}):?\s+(.+)$/i,
        new RegExp(
            `^\\[?([A-Za-z0-9_.]{1,17})\\s*->\\s*(?:you|me|${escapedBotUsername})\\]?\\s*:?\\s*(.+)$`,
            'i'
        )
    ];

    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match) {
            return {
                player: match[1],
                message: match[2].trim()
            };
        }
    }

    return null;
}

function logPrivateMessage(player, message) {
    const signature = `${player.toLowerCase()}\u0000${message}`;
    const now = Date.now();

    if (
        lastPrivateMessage &&
        lastPrivateMessage.signature === signature &&
        now - lastPrivateMessage.timestamp < 2_000
    ) {
        return false;
    }

    lastPrivateMessage = {
        signature,
        timestamp: now
    };
    emitMinecraftEvent(
        'Private Message Received',
        `${player} messaged the Minecraft bot.`,
        'info',
        {
            Player: player,
            Message: message
        }
    );
    return true;
}

function parseIncomingPayment(message) {
    const text = cleanMinecraftMessage(message);
    const playerPattern = String.raw`([A-Za-z0-9_.]{1,17})`;
    const amountPattern = String.raw`(\$?\s*[\d,]+(?:\.\d+)?\s*[kmbt]?)`;
    const patterns = [
        new RegExp(String.raw`^${playerPattern}\s+(?:has\s+)?(?:paid|sent|transferred)\s+you\s+${amountPattern}\b`, 'i'),
        new RegExp(String.raw`^${playerPattern}\s+(?:has\s+)?(?:paid|sent|transferred)\s+${amountPattern}\s+to\s+you\b`, 'i'),
        new RegExp(String.raw`^you\s+(?:have\s+)?(?:received|got)\s+${amountPattern}\s+from\s+${playerPattern}\b`, 'i'),
        new RegExp(String.raw`^${amountPattern}\s+(?:has\s+been\s+)?(?:received|sent|transferred)\s+from\s+${playerPattern}\b`, 'i')
    ];

    for (const pattern of patterns) {
        const match = text.match(pattern);

        if (!match) {
            continue;
        }

        const firstGroupIsAmount = match[1]?.replace(/\s+/g, '').startsWith('$') ||
            /^[\d,]+(?:\.\d+)?[kmbt]?$/i.test(match[1]?.replace(/\s+/g, '') || '');

        return firstGroupIsAmount
            ? {
                player: match[2],
                amount: match[1].replace(/\s+/g, ''),
                message: text
            }
            : {
                player: match[1],
                amount: match[2].replace(/\s+/g, ''),
                message: text
            };
    }

    return null;
}

function logIncomingPayment(message) {
    const payment = parseIncomingPayment(message);

    if (!payment) {
        return false;
    }

    const signature = `${payment.player.toLowerCase()}\u0000${payment.amount}\u0000${payment.message}`;
    const now = Date.now();

    if (
        lastIncomingPayment &&
        lastIncomingPayment.signature === signature &&
        now - lastIncomingPayment.timestamp < 2_000
    ) {
        return false;
    }

    lastIncomingPayment = {
        signature,
        timestamp: now
    };
    emitMinecraftEvent(
        'Incoming Payment Received',
        `${payment.player} paid the Minecraft bot.`,
        'success',
        {
            Player: payment.player,
            Amount: payment.amount,
            'Server response': payment.message
        }
    );
    return true;
}

function timestamp() {
    return new Date().toISOString();
}

function stringifyForLog(value) {
    try {
        return JSON.stringify(value, (_key, item) =>
            typeof item === 'bigint' ? item.toString() : item
        );
    } catch (error) {
        return JSON.stringify({ loggingError: error.message, fallback: String(value) });
    }
}

function requiredEnvironment(name) {
    const value = process.env[name]?.trim();

    if (!value) {
        throw new Error(`${name} is missing from .env`);
    }

    return value;
}

function microsoftLoginAlert(data) {
    const code = data?.user_code?.trim();
    const verificationUrl = data?.verification_uri?.trim() || 'https://www.microsoft.com/link';

    if (!code) {
        return data?.message?.trim() ||
            'Microsoft authentication requires a new device-code login. Check the Minecraft bot logs.';
    }

    return (
        `Minecraft bot Microsoft login required.\n` +
        `One-click login: ${microsoftOneClickLoginUrl(data)}\n` +
        `Backup code: ${code}\n` +
        `Manual login: ${verificationUrl}`
    );
}

function microsoftOneClickLoginUrl(data) {
    const code = data?.user_code?.trim();

    if (!code) {
        return data?.verification_uri?.trim() || 'https://www.microsoft.com/link';
    }

    return `https://www.microsoft.com/link?otc=${encodeURIComponent(code)}`;
}

function minecraftOptions() {
    const port = Number(process.env.MINECRAFT_PORT || 25565);

    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('MINECRAFT_PORT must be a valid port number.');
    }

    const options = {
        host: requiredEnvironment('MINECRAFT_HOST'),
        port,
        username: requiredEnvironment('MINECRAFT_EMAIL'),
        auth: 'microsoft',
        profilesFolder: AUTH_CACHE_DIRECTORY,
        onMsaCode(data) {
            const oneClickLoginUrl = microsoftOneClickLoginUrl(data);
            const verificationUrl = data?.verification_uri || 'https://www.microsoft.com/link';
            const deviceCode = data?.user_code || 'See Railway logs or Twilio SMS';

            console.log('\nMicrosoft authentication is required:');
            console.log(data.message);
            console.log('');
            emitMinecraftEvent(
                'Microsoft Login Required',
                'The Minecraft account requires a new Microsoft device-code login. Use the one-click link to open Microsoft with the code prefilled.',
                'warning',
                {
                    'One-click sign-in': `[Open Microsoft login](${oneClickLoginUrl})`,
                    'Direct URL': oneClickLoginUrl,
                    'Backup device code': deviceCode,
                    'Manual login URL': verificationUrl
                }
            );
            void sendSigninAlert(microsoftLoginAlert(data));
        }
    };

    if (process.env.MINECRAFT_VERSION?.trim()) {
        options.version = process.env.MINECRAFT_VERSION.trim();
    }

    return options;
}

function optionalEnvironment(name) {
    return process.env[name]?.trim() || null;
}

function smsAlertConfiguration() {
    const configuration = {
        accountSid: optionalEnvironment('TWILIO_ACCOUNT_SID'),
        authToken: optionalEnvironment('TWILIO_AUTH_TOKEN'),
        from: optionalEnvironment('TWILIO_FROM_NUMBER'),
        messagingServiceSid: optionalEnvironment('TWILIO_MESSAGING_SERVICE_SID'),
        to: optionalEnvironment('MINECRAFT_ALERT_TO')
    };
    const requiredValues = [
        configuration.accountSid,
        configuration.authToken,
        configuration.to
    ];
    const hasAnyConfiguration = Object.values(configuration).some(Boolean);

    if (!hasAnyConfiguration) {
        return null;
    }

    if (requiredValues.some(value => !value) || (!configuration.from && !configuration.messagingServiceSid)) {
        throw new Error(
            'SMS alerts require TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, MINECRAFT_ALERT_TO, and either TWILIO_FROM_NUMBER or TWILIO_MESSAGING_SERVICE_SID.'
        );
    }

    if (configuration.from && configuration.messagingServiceSid) {
        throw new Error(
            'Configure either TWILIO_FROM_NUMBER or TWILIO_MESSAGING_SERVICE_SID, not both.'
        );
    }

    if (!/^AC[a-f0-9]{32}$/i.test(configuration.accountSid)) {
        throw new Error('TWILIO_ACCOUNT_SID must be a valid Twilio Account SID.');
    }

    if (configuration.messagingServiceSid && !/^MG[a-f0-9]{32}$/i.test(configuration.messagingServiceSid)) {
        throw new Error('TWILIO_MESSAGING_SERVICE_SID must be a valid Twilio Messaging Service SID.');
    }

    if (
        (configuration.from && !/^\+[1-9]\d{7,14}$/.test(configuration.from)) ||
        !/^\+[1-9]\d{7,14}$/.test(configuration.to)
    ) {
        throw new Error('Twilio phone numbers must use E.164 format, such as +15551234567.');
    }

    return configuration;
}

function alertCooldownMs() {
    const cooldown = Number(
        process.env.MINECRAFT_ALERT_COOLDOWN_MS || DEFAULT_ALERT_COOLDOWN_MS
    );

    if (!Number.isInteger(cooldown) || cooldown < 60_000 || cooldown > 24 * 60 * 60 * 1_000) {
        throw new Error('MINECRAFT_ALERT_COOLDOWN_MS must be between 60000 and 86400000.');
    }

    return cooldown;
}

async function sendTwilioSms(message, configuration = smsAlertConfiguration(), fetchImpl = fetch) {
    if (!configuration) {
        return { skipped: true };
    }

    const body = new URLSearchParams({
        To: configuration.to,
        Body: message
    });

    if (configuration.messagingServiceSid) {
        body.set('MessagingServiceSid', configuration.messagingServiceSid);
    } else {
        body.set('From', configuration.from);
    }
    const credentials = Buffer.from(
        `${configuration.accountSid}:${configuration.authToken}`
    ).toString('base64');
    const response = await fetchImpl(
        `https://api.twilio.com/2010-04-01/Accounts/${configuration.accountSid}/Messages.json`,
        {
            method: 'POST',
            headers: {
                Authorization: `Basic ${credentials}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body
        }
    );
    const result = await response.json().catch(() => ({}));

    if (!response.ok) {
        throw new Error(result.message || `Twilio returned HTTP ${response.status}.`);
    }

    return result;
}

async function sendMinecraftAlert(reason, options = {}) {
    let configuration;
    let cooldown;

    try {
        configuration = smsAlertConfiguration();
        if (!configuration) {
            return;
        }
        cooldown = alertCooldownMs();
    } catch (error) {
        console.error(`Minecraft SMS alert configuration error: ${error.message}`);
        return;
    }

    const now = Date.now();
    if (now - lastSmsAlertAt < cooldown) {
        console.log('Minecraft SMS suppressed by the alert cooldown.');
        return;
    }

    lastSmsAlertAt = now;
    const host = process.env.MINECRAFT_HOST?.trim() || 'the configured server';
    const title = options.title || 'Minecraft bot needs attention';
    const message =
        `${title} for ${host}. ` +
        `Reason: ${String(reason || 'unknown reason').slice(0, 300)}`;

    try {
        const result = await sendTwilioSms(message, configuration);
        console.log(`Minecraft SMS queued${result.sid ? ` (${result.sid})` : ''}.`);
    } catch (error) {
        console.error(`Could not send Minecraft SMS: ${error.message}`);
    }
}

async function sendSigninAlert(reason) {
    return sendMinecraftAlert(reason, {
        title: 'Minecraft bot needs sign-in attention'
    });
}

async function sendUnexpectedDisconnectAlert(reason) {
    return sendMinecraftAlert(reason, {
        title: 'Minecraft bot disconnected unexpectedly'
    });
}

function isConnected() {
    return Boolean(bot?.player && bot?._client?.socket && !bot._client.socket.destroyed);
}

function sendChat(message) {
    const sendTask = chatCommandQueue.then(async () => {
        const delayMs = chatCommandDelayMs();
        const waitMs = delayMs - (Date.now() - lastChatCommandAt);

        if (waitMs > 0) {
            await sleep(waitMs);
        }

        if (!isConnected()) {
            throw new Error('The Minecraft bot is not connected yet.');
        }

        bot.chat(message);
        lastChatCommandAt = Date.now();
    });

    chatCommandQueue = sendTask.catch(() => {});

    return sendTask;
}

function validatePlayer(player) {
    if (!/^[A-Za-z0-9_.]{1,17}$/.test(player)) {
        throw new Error('Player must be a valid Java/Bedrock username.');
    }
}

function validatePaymentAmount(amount) {
    if (!/^(?:\d+)(?:\.\d+)?[kmbt]?$/i.test(amount) || Number.parseFloat(amount) <= 0) {
        throw new Error('Amount must look like 500, 10k, 2.5m, 1b, or 1t.');
    }
}

function validateMinecraftCommand(command, fallback = '/bal') {
    const trimmedCommand = String(command || fallback).trim();

    if (!trimmedCommand.startsWith('/') || /[\r\n]/.test(trimmedCommand)) {
        throw new Error('Minecraft command must start with / and stay on one line.');
    }

    return trimmedCommand;
}

function parseMinecraftCommandList(commands) {
    return String(commands || '')
        .split(',')
        .map(command => command.trim())
        .filter(Boolean);
}

function uniqueMinecraftCommands(commands) {
    const seen = new Set();
    const uniqueCommands = [];

    for (const command of commands) {
        const validatedCommand = validateMinecraftCommand(command);
        const commandKey = validatedCommand.toLowerCase();

        if (seen.has(commandKey)) {
            continue;
        }

        seen.add(commandKey);
        uniqueCommands.push(validatedCommand);
    }

    return uniqueCommands;
}

function buildPaymentCommand(player, amount) {
    validatePlayer(player);
    validatePaymentAmount(amount);

    return `/pay ${player} ${amount}`;
}

function buildMessageCommand(player, message) {
    validatePlayer(player);

    const trimmedMessage = message.trim();
    if (!trimmedMessage || /[\r\n]/.test(trimmedMessage)) {
        throw new Error('Message must contain text on one line.');
    }

    return `/msg ${player} ${trimmedMessage}`;
}

function buildBalanceCommands() {
    const configuredCommands = process.env.MINECRAFT_BALANCE_COMMANDS
        ? parseMinecraftCommandList(process.env.MINECRAFT_BALANCE_COMMANDS)
        : [
            process.env.MINECRAFT_BALANCE_COMMAND,
            ...DEFAULT_BALANCE_COMMANDS
        ].filter(Boolean);
    const commands = uniqueMinecraftCommands(configuredCommands);

    if (commands.length === 0) {
        throw new Error('At least one Minecraft balance command must be configured.');
    }

    return commands;
}

function buildBalanceCommand() {
    return buildBalanceCommands()[0];
}

function paymentTimeoutMs() {
    const timeout = Number(process.env.MINECRAFT_PAYMENT_TIMEOUT_MS || DEFAULT_PAYMENT_TIMEOUT_MS);

    if (!Number.isInteger(timeout) || timeout < 1_000 || timeout > 60_000) {
        throw new Error('MINECRAFT_PAYMENT_TIMEOUT_MS must be between 1000 and 60000.');
    }

    return timeout;
}

function balanceTimeoutMs() {
    const timeout = Number(
        process.env.MINECRAFT_BALANCE_TIMEOUT_MS ||
        process.env.MINECRAFT_PAYMENT_TIMEOUT_MS ||
        DEFAULT_PAYMENT_TIMEOUT_MS
    );

    if (!Number.isInteger(timeout) || timeout < 1_000 || timeout > 60_000) {
        throw new Error('MINECRAFT_BALANCE_TIMEOUT_MS must be between 1000 and 60000.');
    }

    return timeout;
}

function balanceCommandTimeoutMs() {
    const timeout = Number(
        process.env.MINECRAFT_BALANCE_COMMAND_TIMEOUT_MS ||
        DEFAULT_BALANCE_COMMAND_TIMEOUT_MS
    );

    if (!Number.isInteger(timeout) || timeout < 1_000 || timeout > 60_000) {
        throw new Error('MINECRAFT_BALANCE_COMMAND_TIMEOUT_MS must be between 1000 and 60000.');
    }

    return timeout;
}

function paymentResponsePatterns() {
    try {
        return {
            success: new RegExp(
                process.env.MINECRAFT_PAYMENT_SUCCESS_PATTERN || DEFAULT_PAYMENT_SUCCESS_PATTERN,
                'i'
            ),
            failure: new RegExp(
                process.env.MINECRAFT_PAYMENT_FAILURE_PATTERN || DEFAULT_PAYMENT_FAILURE_PATTERN,
                'i'
            )
        };
    } catch (error) {
        throw new Error(`Invalid Minecraft payment response pattern: ${error.message}`);
    }
}

function balanceResponsePattern() {
    try {
        return new RegExp(
            process.env.MINECRAFT_BALANCE_PATTERN || DEFAULT_BALANCE_RESPONSE_PATTERN,
            'i'
        );
    } catch (error) {
        throw new Error(`Invalid Minecraft balance response pattern: ${error.message}`);
    }
}

function balanceFailurePattern() {
    try {
        return new RegExp(
            process.env.MINECRAFT_BALANCE_FAILURE_PATTERN || DEFAULT_BALANCE_FAILURE_PATTERN,
            'i'
        );
    } catch (error) {
        throw new Error(`Invalid Minecraft balance failure pattern: ${error.message}`);
    }
}

function cleanMinecraftMessage(message) {
    return String(message).replace(/§[0-9A-FK-OR]/gi, '').trim();
}

function parseMinecraftAmountValue(amount) {
    const normalizedAmount = String(amount || '').toLowerCase().replace(/[$,\s]/g, '');
    const match = normalizedAmount.match(/^(\d+)(?:\.(\d+))?([kmbt])?$/);
    const multipliers = {
        k: 1_000n,
        m: 1_000_000n,
        b: 1_000_000_000n,
        t: 1_000_000_000_000n
    };

    if (!match) {
        throw new Error(`Could not parse Minecraft amount: ${amount}`);
    }

    const [, wholePart, decimalPart = '', suffix] = match;
    const scale = 10n ** BigInt(decimalPart.length);
    const multiplier = suffix ? multipliers[suffix] : 1n;
    const rawNumber = BigInt(`${wholePart}${decimalPart}`);

    return (rawNumber * multiplier) / scale;
}

function classifyPaymentResponse(message, player, patterns = paymentResponsePatterns()) {
    const cleaned = cleanMinecraftMessage(message);

    if (patterns.failure.test(cleaned)) {
        return { status: 'failed', message: cleaned };
    }

    if (patterns.success.test(cleaned)) {
        const playerPattern = new RegExp(
            `(?<![A-Za-z0-9_])${player.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`,
            'i'
        );

        if (playerPattern.test(cleaned)) {
            return { status: 'completed', message: cleaned };
        }
    }

    return null;
}

function classifyBalanceResponse(message, pattern = balanceResponsePattern()) {
    const cleaned = cleanMinecraftMessage(message);
    const match = cleaned.match(pattern);

    if (!match) {
        return null;
    }

    const amountText = match.slice(1).find(Boolean);

    if (!amountText) {
        return null;
    }

    return {
        amount: parseMinecraftAmountValue(amountText),
        amountText,
        message: cleaned
    };
}

function classifyBalanceFailure(message, pattern = balanceFailurePattern()) {
    const cleaned = cleanMinecraftMessage(message);

    if (!pattern.test(cleaned)) {
        return null;
    }

    return {
        message: cleaned
    };
}

function rememberPendingPaymentResponse(payment, message) {
    const cleaned = cleanMinecraftMessage(message);

    if (!cleaned) {
        return;
    }

    payment.unmatchedResponses.push(cleaned);

    if (payment.unmatchedResponses.length > MAX_PENDING_PAYMENT_RESPONSES) {
        payment.unmatchedResponses.shift();
    }
}

function pendingPaymentResponseSummary(payment) {
    if (!payment?.unmatchedResponses?.length) {
        return 'No unmatched server messages were seen while waiting.';
    }

    return payment.unmatchedResponses.join('\n');
}

function handlePaymentResponse(message) {
    if (!pendingPayment) {
        return;
    }

    const result = classifyPaymentResponse(message, pendingPayment.player, pendingPayment.patterns);
    if (!result) {
        rememberPendingPaymentResponse(pendingPayment, message);
        return;
    }

    const payment = pendingPayment;
    pendingPayment = null;
    clearTimeout(payment.timeout);

    if (result.status === 'completed') {
        if (shouldEmitImmediatePaymentLog(payment.context)) {
            emitMinecraftEvent(
                'Payment Successful',
                `The server confirmed the payment to ${payment.player}.`,
                'success',
                {
                    Player: payment.player,
                    Amount: payment.amount,
                    'Server response': result.message,
                    ...actionDetails(payment.context)
                }
            );
        }
        payment.resolve(result);
    } else {
        if (shouldEmitImmediatePaymentLog(payment.context)) {
            emitMinecraftEvent(
                'Payment Unsuccessful',
                `The server rejected the payment to ${payment.player}.`,
                'error',
                {
                    Player: payment.player,
                    Amount: payment.amount,
                    'Server response': result.message,
                    ...actionDetails(payment.context)
                }
            );
        }
        payment.reject(new Error(result.message));
    }
}

function failBalanceCheck(balance, reason) {
    if (pendingBalance !== balance) {
        return;
    }

    pendingBalance = null;

    if (balance.timeout) {
        clearTimeout(balance.timeout);
        balance.timeout = null;
    }

    const message = 'No balance response was received.';

    balance.reject(new Error(`${message} ${reason}`));
}

async function sendBalanceAttempt(balance) {
    if (pendingBalance !== balance) {
        return;
    }

    const command = balance.commands[balance.commandIndex];
    const remainingMs = balance.deadlineAt - Date.now();

    if (!command || remainingMs <= 0) {
        failBalanceCheck(balance, 'The balance check timed out.');
        return;
    }

    const timeoutMs = Math.min(balance.attemptTimeoutMs, remainingMs);

    balance.command = command;

    try {
        await sendChat(command);

        if (pendingBalance !== balance) {
            return;
        }

        balance.timeout = setTimeout(() => {
            if (pendingBalance !== balance) {
                return;
            }

            tryNextBalanceCommand(
                balance,
                `A balance command did not respond within ${Math.ceil(timeoutMs / 1000)} seconds.`
            );
        }, timeoutMs);

        console.log(`Balance command sent: ${command}`);
    } catch (error) {
        pendingBalance = null;
        if (balance.timeout) {
            clearTimeout(balance.timeout);
            balance.timeout = null;
        }
        balance.reject(error);
    }
}

function tryNextBalanceCommand(balance, reason) {
    if (pendingBalance !== balance) {
        return;
    }

    if (balance.timeout) {
        clearTimeout(balance.timeout);
        balance.timeout = null;
    }

    balance.commandIndex += 1;

    if (balance.commandIndex >= balance.commands.length) {
        failBalanceCheck(balance, reason);
        return;
    }

    console.log(`${reason} Trying ${balance.commands[balance.commandIndex]} next.`);
    void sendBalanceAttempt(balance);
}

function handleBalanceResponse(message) {
    if (!pendingBalance) {
        return;
    }

    const balance = pendingBalance;
    let result;

    try {
        result = classifyBalanceResponse(message, balance.pattern);
    } catch (error) {
        pendingBalance = null;
        clearTimeout(balance.timeout);
        balance.reject(error);
        return;
    }

    if (result) {
        pendingBalance = null;
        clearTimeout(balance.timeout);

        balance.resolve({
            ...result,
            command: balance.command
        });
        return;
    }

    const failure = classifyBalanceFailure(message, balance.failurePattern);

    if (failure) {
        tryNextBalanceCommand(balance, `A balance command was rejected: ${failure.message}`);
    }
}

function cancelPendingPayment(reason) {
    if (!pendingPayment) {
        return;
    }

    const payment = pendingPayment;
    pendingPayment = null;
    clearTimeout(payment.timeout);
    payment.reject(new Error(reason));
}

function cancelPendingBalance(reason) {
    if (!pendingBalance) {
        return;
    }

    const balance = pendingBalance;
    pendingBalance = null;
    clearTimeout(balance.timeout);
    balance.reject(new Error(reason));
}

function queueMinecraftOperation(task) {
    const queuedTask = minecraftOperationQueue.then(task, task);
    minecraftOperationQueue = queuedTask.catch(() => {});

    return queuedTask;
}

function balanceDropCoversPayment(beforeBalance, afterBalance, paymentAmount) {
    if (!beforeBalance || !afterBalance) {
        return {
            confirmed: false,
            decrease: null
        };
    }

    const decrease = BigInt(beforeBalance.amount) - BigInt(afterBalance.amount);

    return {
        confirmed: decrease >= paymentAmount,
        decrease
    };
}

function formatPaymentBalanceDetails(beforeBalance, afterBalance, decrease) {
    const details = {};

    if (beforeBalance) {
        details['Balance before'] = beforeBalance.amount.toString();
    }

    if (afterBalance) {
        details['Balance after'] = afterBalance.amount.toString();
    }

    if (decrease !== null) {
        details['Balance decrease'] = decrease.toString();
    }

    return details;
}

async function notifyPaymentStage(context, stage, details = {}, options = {}) {
    if (typeof context?.onPaymentStage !== 'function') {
        return;
    }

    try {
        await context.onPaymentStage(stage, details);
    } catch (error) {
        if (options.required) {
            throw error;
        }

        console.error(`Payment stage callback failed for ${stage}:`);
        console.error(error);
    }
}

function payPlayerDirect(player, amount, context = {}) {
    if (pendingPayment) {
        throw new Error(`A payment to ${pendingPayment.player} is still waiting for confirmation.`);
    }
    if (pendingBalance) {
        throw new Error('A balance check is still waiting for confirmation.');
    }

    const command = buildPaymentCommand(player, amount);
    const patterns = paymentResponsePatterns();
    const timeoutMs = paymentTimeoutMs();

    return new Promise((resolve, reject) => {
        const payment = {
            player,
            amount,
            patterns,
            unmatchedResponses: [],
            timeout: null,
            resolve,
            reject,
            context
        };

        pendingPayment = payment;

        try {
            sendChat(command)
                .then(async () => {
                    if (pendingPayment !== payment) {
                        return;
                    }

                    await notifyPaymentStage(context, 'command_sent', {
                        player,
                        amount,
                        command
                    });

                    if (pendingPayment !== payment) {
                        return;
                    }

                    payment.timeout = setTimeout(() => {
                        if (pendingPayment !== payment) {
                            return;
                        }

                        pendingPayment = null;
                        const responseSummary = pendingPaymentResponseSummary(payment);
                        if (shouldEmitImmediatePaymentLog(context)) {
                            emitMinecraftEvent(
                                'Payment Confirmation Timed Out',
                                `No server confirmation was received for the payment to ${player}.`,
                                'warning',
                                {
                                    Player: player,
                                    Amount: amount,
                                    Timeout: `${timeoutMs / 1000} seconds`,
                                    'Unmatched server responses': responseSummary,
                                    ...actionDetails(context)
                                }
                            );
                        }
                        reject(
                            new Error(
                                `No payment confirmation was received within ${timeoutMs / 1000} seconds. ` +
                                `Unmatched server responses: ${responseSummary}`
                            )
                        );
                    }, timeoutMs);

                    console.log(`Payment command sent: ${command}`);
                    console.log('Waiting for the server to confirm the payment...');
                })
                .catch(error => {
                    if (pendingPayment === payment) {
                        pendingPayment = null;
                    }

                    if (payment.timeout) {
                        clearTimeout(payment.timeout);
                        payment.timeout = null;
                    }

                    if (shouldEmitImmediatePaymentLog(context)) {
                        emitMinecraftEvent(
                            'Payment Failed to Send',
                            error.message,
                            'error',
                            {
                                Player: player,
                                Amount: amount,
                                ...actionDetails(context)
                            }
                        );
                    }
                    reject(error);
                });
        } catch (error) {
            pendingPayment = null;
            if (shouldEmitImmediatePaymentLog(context)) {
                emitMinecraftEvent(
                    'Payment Failed to Send',
                    error.message,
                    'error',
                    {
                        Player: player,
                        Amount: amount,
                        ...actionDetails(context)
                    }
                );
            }
            reject(error);
        }
    });
}

async function payPlayerWithBalanceChecks(player, amount, context = {}) {
    const paymentAmount = parseMinecraftAmountValue(amount);
    let beforeBalance;

    try {
        beforeBalance = await checkBalanceDirect(context);
    } catch (error) {
        error.paymentAttempted = false;
        throw error;
    }

    try {
        await notifyPaymentStage(context, 'balance_before', {
            player,
            amount,
            balance: beforeBalance
        }, {
            required: true
        });
    } catch (error) {
        error.paymentAttempted = false;
        throw error;
    }

    const directPaymentContext = {
        ...context,
        deferPaymentLogUntilBalanceCheck: true
    };
    let paymentResult = null;
    let paymentError = null;

    try {
        paymentResult = await payPlayerDirect(player, amount, directPaymentContext);
    } catch (error) {
        paymentError = error;
    }

    let afterBalance = null;
    let afterBalanceError = null;

    try {
        afterBalance = await checkBalanceDirect(context);
    } catch (error) {
        afterBalanceError = error;
    }

    await notifyPaymentStage(context, 'balance_after', {
        player,
        amount,
        balance: afterBalance,
        error: afterBalanceError
    });

    const {
        confirmed,
        decrease
    } = balanceDropCoversPayment(beforeBalance, afterBalance, paymentAmount);
    const balanceDetails = formatPaymentBalanceDetails(beforeBalance, afterBalance, decrease);

    if (paymentResult) {
        if (!shouldSuppressPaymentLog(context)) {
            emitMinecraftEvent(
                'Payment Successful',
                `The server confirmed the payment to ${player}.`,
                afterBalanceError ? 'warning' : 'success',
                {
                    Player: player,
                    Amount: amount,
                    'Server response': paymentResult.message,
                    'Balance confirmed': confirmed ? 'yes' : 'no',
                    ...(afterBalanceError ? { 'After balance check': afterBalanceError.message } : {}),
                    ...balanceDetails,
                    ...actionDetails(context)
                }
            );
        }

        return {
            ...paymentResult,
            balanceBefore: beforeBalance,
            balanceAfter: afterBalance,
            balanceDecrease: decrease,
            balanceConfirmed: confirmed,
            balanceCheckAfterError: afterBalanceError?.message || null
        };
    }

    if (confirmed) {
        const message =
            `${paymentError?.message || 'Payment was not confirmed by chat.'} ` +
            `Balance decreased by ${decrease.toString()}, so the payment is assumed complete.`;

        if (!shouldSuppressPaymentLog(context)) {
            emitMinecraftEvent(
                'Payment Assumed Successful',
                `The payment to ${player} was treated as successful because the bot balance decreased.`,
                'warning',
                {
                    Player: player,
                    Amount: amount,
                    'Payment error': paymentError?.message || 'No payment confirmation was received.',
                    ...balanceDetails,
                    ...actionDetails(context)
                }
            );
        }

        return {
            status: 'completed',
            message,
            balanceAssumed: true,
            balanceBefore: beforeBalance,
            balanceAfter: afterBalance,
            balanceDecrease: decrease,
            balanceConfirmed: true
        };
    }

    const failureDetails = afterBalanceError
        ? `${paymentError?.message || 'Payment failed.'} After-payment balance check failed: ${afterBalanceError.message}`
        : paymentError?.message || 'Payment failed.';

    if (!shouldSuppressPaymentLog(context)) {
        emitMinecraftEvent(
            'Payment Unsuccessful',
            `The payment to ${player} failed and the bot balance did not confirm it.`,
            'error',
            {
                Player: player,
                Amount: amount,
                Error: failureDetails,
                ...balanceDetails,
                ...actionDetails(context)
            }
        );
    }

    const error = new Error(failureDetails);
    error.paymentAttempted = true;
    throw error;
}

function payPlayer(player, amount, context = {}) {
    buildPaymentCommand(player, amount);
    parseMinecraftAmountValue(amount);

    return queueMinecraftOperation(() => payPlayerWithBalanceChecks(player, amount, context));
}

function checkBalanceDirect(context = {}) {
    if (pendingPayment) {
        throw new Error(`A payment to ${pendingPayment.player} is still waiting for confirmation.`);
    }
    if (pendingBalance) {
        throw new Error('A balance check is still waiting for confirmation.');
    }

    const commands = buildBalanceCommands();
    const pattern = balanceResponsePattern();
    const failurePattern = balanceFailurePattern();
    const totalTimeoutMs = balanceTimeoutMs();
    const attemptTimeoutMs = balanceCommandTimeoutMs();

    return new Promise((resolve, reject) => {
        pendingBalance = {
            commands,
            command: null,
            commandIndex: 0,
            pattern,
            failurePattern,
            timeout: null,
            deadlineAt: Date.now() + totalTimeoutMs,
            totalTimeoutMs,
            attemptTimeoutMs,
            resolve,
            reject,
            context
        };

        void sendBalanceAttempt(pendingBalance);
    });
}

function checkBalance(context = {}) {
    return queueMinecraftOperation(() => checkBalanceDirect(context));
}

async function messagePlayer(player, message, context = {}) {
    const command = buildMessageCommand(player, message);
    await sendChat(command);
    console.log(`Private message sent to ${player}.`);
    emitMinecraftEvent(
        'Private Message Sent',
        `The Minecraft bot sent a private message to ${player}.`,
        'success',
        {
            Player: player,
            Message: message,
            ...actionDetails(context)
        }
    );
}

async function goHomeNumber(homeNumber, context = {}) {
    const normalizedHomeNumber = Number(homeNumber);

    if (!Number.isInteger(normalizedHomeNumber) || normalizedHomeNumber < 1 || normalizedHomeNumber > 99) {
        throw new Error('Home number must be a whole number between 1 and 99.');
    }

    const command = `/home ${normalizedHomeNumber}`;
    await sendChat(command);
    console.log(`Minecraft command sent: ${command}`);
    emitMinecraftEvent(
        'Home Command Sent',
        `The Minecraft bot was sent to home ${normalizedHomeNumber}.`,
        'success',
        {
            Command: command,
            Home: String(normalizedHomeNumber),
            ...actionDetails(context)
        }
    );
}

function goHome(context = {}) {
    return goHomeNumber(1, context);
}

function cobbleTargetLabel(block) {
    if (!block) {
        return 'No block in crosshair';
    }

    return `${block.name} at ${block.position.x}, ${block.position.y}, ${block.position.z}`;
}

function cobbleBlockKey(block) {
    if (!block?.position) {
        return null;
    }

    return `${block.position.x},${block.position.y},${block.position.z}`;
}

function cobbleDigFace(block) {
    return Number.isInteger(block?.face) ? block.face : 1;
}

function cobbleModeStatus() {
    if (!cobbleMode) {
        return {
            active: false
        };
    }

    return {
        active: true,
        startedAt: cobbleMode.startedAt.toISOString(),
        lastTarget: cobbleMode.lastTarget || null,
        lastError: cobbleMode.lastError || null,
        wiggleCompleted: Boolean(cobbleMode.wiggleCompleted),
        destroyHeld: Boolean(cobbleMode.destroyingBlockKey),
        useHeld: Boolean(cobbleMode.bot?.usingHeldItem),
        usePacketsSent: cobbleMode.usePacketsSent || 0,
        digsCompleted: cobbleMode.digsCompleted
    };
}

function activateCobbleUseItem(state, now = Date.now(), force = false) {
    const shouldSendUsePacket =
        force ||
        !state.bot.usingHeldItem ||
        !state.lastUseItemAt ||
        now - state.lastUseItemAt >= DEFAULT_COBBLE_USE_ITEM_MS;

    if (shouldSendUsePacket) {
        state.bot.activateItem();
        state.lastUseItemAt = now;
        state.usePacketsSent += 1;
    }
}

async function forceCobbleLookUp(state) {
    await state.bot.look(
        state.bot.entity.yaw,
        COBBLE_LOOK_STRAIGHT_UP_PITCH,
        true
    );
}

function releaseCobbleMovementControls(state) {
    for (const control of COBBLE_WIGGLE_CONTROLS) {
        state.bot.setControlState(control, false);
    }
}

async function runCobbleStartupWiggle(state) {
    if (state.wiggleStarted || state.wiggleCompleted) {
        return;
    }

    state.wiggleStarted = true;

    try {
        releaseCobbleMovementControls(state);

        for (const control of COBBLE_WIGGLE_CONTROLS) {
            if (!state.active || cobbleMode !== state || !isConnected() || bot !== state.bot) {
                break;
            }

            state.lastWiggleControl = control;
            state.bot.setControlState(control, true);
            await sleep(DEFAULT_COBBLE_WIGGLE_TAP_MS);
            state.bot.setControlState(control, false);
            await sleep(DEFAULT_COBBLE_WIGGLE_GAP_MS);
        }
    } finally {
        releaseCobbleMovementControls(state);
        state.wiggleCompleted = true;
    }
}

function restoreCobbleControls(state) {
    cancelCobbleDestroyHold(state);

    try {
        state.bot.stopDigging?.();
    } catch (error) {
        state.lastError = error.message;
    }

    try {
        if (state.bot.usingHeldItem) {
            state.bot.deactivateItem();
        }
    } catch (error) {
        state.lastError = error.message;
    }

    try {
        releaseCobbleMovementControls(state);
        state.bot.setControlState('sneak', false);
    } catch (error) {
        state.lastError = error.message;
    }
}

function writeCobbleDigPacket(state, status, block, face) {
    state.bot._client.write('block_dig', {
        status,
        location: block.position,
        face
    });
}

function cancelCobbleDestroyHold(state) {
    if (!state?.destroyingBlock || !state?.bot?._client) {
        return;
    }

    try {
        writeCobbleDigPacket(
            state,
            1,
            state.destroyingBlock,
            state.destroyFace ?? cobbleDigFace(state.destroyingBlock)
        );
    } catch (error) {
        state.lastError = error.message;
    } finally {
        state.destroyingBlock = null;
        state.destroyingBlockKey = null;
        state.destroyFace = null;
        state.destroyStartedAt = null;
        state.destroyFinishAt = null;
        state.lastSwingAt = null;
    }
}

function swingCobbleDestroyArm(state, now = Date.now(), force = false) {
    if (!force && state.lastSwingAt && now - state.lastSwingAt < DEFAULT_COBBLE_SWING_MS) {
        return;
    }

    state.bot.swingArm('right');
    state.lastSwingAt = now;
}

function startCobbleDestroyHold(state, block, now = Date.now()) {
    const face = cobbleDigFace(block);
    const rawDigTime = Number(state.bot.digTime(block));
    const digTime = Number.isFinite(rawDigTime)
        ? Math.max(DEFAULT_COBBLE_MIN_DIG_MS, rawDigTime)
        : DEFAULT_COBBLE_ERROR_MS;

    writeCobbleDigPacket(state, 0, block, face);

    state.destroyingBlock = block;
    state.destroyingBlockKey = cobbleBlockKey(block);
    state.destroyFace = face;
    state.destroyStartedAt = now;
    state.destroyFinishAt = now + digTime;
    swingCobbleDestroyArm(state, now, true);
}

function finishCobbleDestroyHold(state) {
    if (!state.destroyingBlock) {
        return;
    }

    const block = state.destroyingBlock;
    const face = state.destroyFace ?? cobbleDigFace(block);

    writeCobbleDigPacket(state, 2, block, face);

    state.digsCompleted += 1;
    state.destroyingBlock = null;
    state.destroyingBlockKey = null;
    state.destroyFace = null;
    state.destroyStartedAt = null;
    state.destroyFinishAt = null;
}

function tickCobbleDestroyHold(state, block) {
    const now = Date.now();
    const blockKey = cobbleBlockKey(block);

    if (!blockKey) {
        cancelCobbleDestroyHold(state);
        swingCobbleDestroyArm(state, now);
        return;
    }

    if (state.destroyingBlockKey && state.destroyingBlockKey !== blockKey) {
        cancelCobbleDestroyHold(state);
    }

    if (!state.destroyingBlockKey) {
        startCobbleDestroyHold(state, block, now);
        return;
    }

    swingCobbleDestroyArm(state, now);

    if (state.destroyFinishAt && now >= state.destroyFinishAt) {
        finishCobbleDestroyHold(state);
    }
}

async function runCobbleModeLoop(state) {
    while (cobbleMode === state && state.active) {
        if (!isConnected() || bot !== state.bot) {
            state.lastError = 'Minecraft bot disconnected.';
            break;
        }

        try {
            await forceCobbleLookUp(state);
            await runCobbleStartupWiggle(state);
            state.bot.setControlState('sneak', true);
            await forceCobbleLookUp(state);
            activateCobbleUseItem(state);

            const block = state.bot.blockAtCursor(DEFAULT_COBBLE_DIG_DISTANCE);
            state.lastTarget = cobbleTargetLabel(block);

            if (!block) {
                tickCobbleDestroyHold(state, null);
                await sleep(DEFAULT_COBBLE_IDLE_MS);
                continue;
            }

            if (!state.bot.canDigBlock(block)) {
                state.lastError = `Cannot dig ${state.lastTarget}.`;
                cancelCobbleDestroyHold(state);
                swingCobbleDestroyArm(state, Date.now(), true);
                await sleep(DEFAULT_COBBLE_ERROR_MS);
                continue;
            }

            tickCobbleDestroyHold(state, block);
            state.lastError = null;
            await sleep(DEFAULT_COBBLE_IDLE_MS);
        } catch (error) {
            if (!state.active || cobbleMode !== state) {
                break;
            }

            state.lastError = error.message;

            try {
                cancelCobbleDestroyHold(state);
                swingCobbleDestroyArm(state, Date.now(), true);
            } catch {
                // Ignore secondary animation failures while retrying cobble mode.
            }

            await sleep(DEFAULT_COBBLE_ERROR_MS);
        }
    }

    if (cobbleMode === state && state.active) {
        const reason = state.lastError || 'Cobble mode stopped unexpectedly.';
        stopCobbleMode(
            {
                actorTag: 'Minecraft bot',
                source: 'Cobble loop'
            },
            reason,
            'warning'
        );
    }
}

function startCobbleMode(context = {}) {
    if (!isConnected()) {
        throw new Error('The Minecraft bot is not connected yet.');
    }

    if (cobbleMode) {
        return {
            started: false,
            status: cobbleModeStatus()
        };
    }

    cobbleMode = {
        bot,
        active: true,
        startedAt: new Date(),
        lastTarget: null,
        lastError: null,
        digsCompleted: 0,
        destroyingBlock: null,
        destroyingBlockKey: null,
        destroyFace: null,
        destroyStartedAt: null,
        destroyFinishAt: null,
        lastSwingAt: null,
        lastUseItemAt: null,
        usePacketsSent: 0,
        wiggleStarted: false,
        wiggleCompleted: false,
        lastWiggleControl: null
    };

    void forceCobbleLookUp(cobbleMode).catch(error => {
        if (cobbleMode) {
            cobbleMode.lastError = error.message;
        }
    });

    emitMinecraftEvent(
        'Cobble Mode Started',
        'The Minecraft bot started cobble mode: startup movement wiggle, looking straight up, sneak/shift held, left click/destroy held at the crosshair, and right click/use item held.',
        'success',
        {
            'Dig distance': `${DEFAULT_COBBLE_DIG_DISTANCE} blocks`,
            'Startup wiggle': COBBLE_WIGGLE_CONTROLS.join(', '),
            ...actionDetails(context)
        }
    );

    void runCobbleModeLoop(cobbleMode);

    return {
        started: true,
        status: cobbleModeStatus()
    };
}

function stopCobbleMode(context = {}, reason = 'Cobble mode was stopped.', level = 'info') {
    if (!cobbleMode) {
        return {
            stopped: false,
            status: {
                active: false
            }
        };
    }

    const state = cobbleMode;
    cobbleMode = null;
    state.active = false;
    restoreCobbleControls(state);

    emitMinecraftEvent(
        'Cobble Mode Stopped',
        reason,
        level,
        {
            'Digs completed': String(state.digsCompleted),
            'Last target': state.lastTarget || 'None',
            ...(state.lastError ? { 'Last error': state.lastError } : {}),
            ...actionDetails(context)
        }
    );

    return {
        stopped: true,
        status: {
            active: false,
            digsCompleted: state.digsCompleted,
            lastTarget: state.lastTarget || null,
            lastError: state.lastError || null
        }
    };
}

function vectorSnapshot(vector) {
    if (!vector) {
        return null;
    }

    return {
        x: Number(vector.x || 0),
        y: Number(vector.y || 0),
        z: Number(vector.z || 0)
    };
}

function formatVectorSnapshot(vector) {
    if (!vector) {
        return 'unknown';
    }

    return `${vector.x.toFixed(3)}, ${vector.y.toFixed(3)}, ${vector.z.toFixed(3)}`;
}

function resetMinecraftBotControls(context = {}) {
    if (!isConnected()) {
        throw new Error('The Minecraft bot is not connected yet.');
    }

    const stoppedCobble = cobbleMode
        ? stopCobbleMode(
            context,
            'Cobble mode was stopped by an unstuck/reset request.'
        ).stopped
        : false;

    const errors = [];

    try {
        bot.stopDigging?.();
    } catch (error) {
        errors.push(`stopDigging: ${error.message}`);
    }

    try {
        bot.deactivateItem();
    } catch (error) {
        errors.push(`deactivateItem: ${error.message}`);
    }

    try {
        bot.clearControlStates();
    } catch (error) {
        errors.push(`clearControlStates: ${error.message}`);
    }

    bot.physicsEnabled = true;

    const position = vectorSnapshot(bot.entity?.position);
    const velocity = vectorSnapshot(bot.entity?.velocity);
    const controlState = {
        forward: bot.getControlState('forward'),
        back: bot.getControlState('back'),
        left: bot.getControlState('left'),
        right: bot.getControlState('right'),
        jump: bot.getControlState('jump'),
        sprint: bot.getControlState('sprint'),
        sneak: bot.getControlState('sneak')
    };
    const result = {
        stoppedCobble,
        physicsEnabled: bot.physicsEnabled,
        position,
        velocity,
        controlState,
        errors
    };

    emitMinecraftEvent(
        'Minecraft Bot Controls Reset',
        errors.length > 0
            ? 'The Minecraft bot controls were reset with some warnings.'
            : 'The Minecraft bot controls were reset.',
        errors.length > 0 ? 'warning' : 'success',
        {
            'Stopped cobble mode': stoppedCobble ? 'yes' : 'no',
            'Physics enabled': bot.physicsEnabled ? 'yes' : 'no',
            Position: formatVectorSnapshot(position),
            Velocity: formatVectorSnapshot(velocity),
            Sneaking: controlState.sneak ? 'yes' : 'no',
            ...(errors.length > 0 ? { Errors: errors.join('\n') } : {}),
            ...actionDetails(context)
        }
    );

    return result;
}

function randomReconnectDelayMinutes(random = Math.random) {
    return Math.floor(random() * (
        MAX_RECONNECT_DELAY_MINUTES - MIN_RECONNECT_DELAY_MINUTES + 1
    )) + MIN_RECONNECT_DELAY_MINUTES;
}

function scheduleReconnect() {
    if (shuttingDown || reconnectTimer) {
        return;
    }

    const delayMinutes = randomReconnectDelayMinutes();
    const delayMs = delayMinutes * 60_000;

    console.log(`Reconnecting in ${delayMinutes} minutes...`);
    emitMinecraftEvent(
        'Minecraft Reconnect Scheduled',
        `The Minecraft bot will automatically reconnect in ${delayMinutes} minutes unless the Don uses /bot start sooner.`,
        'warning',
        {
            Delay: `${delayMinutes} minutes`
        }
    );
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect({
            actorTag: 'Automatic reconnect',
            source: 'Reconnect timer'
        });
    }, delayMs);
}

function connect(context = {}) {
    shuttingDown = false;

    if (bot) {
        if (isConnected()) {
            console.log('Minecraft bot is already connected.');
            return { status: 'connected', username: bot.username };
        }

        console.log('Minecraft bot is already connecting.');
        return { status: 'connecting', username: bot.username || null };
    }

    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    const options = minecraftOptions();
    console.log(`Connecting to ${options.host}:${options.port}...`);
    emitMinecraftEvent(
        'Minecraft Bot Starting',
        `Connecting to ${options.host}:${options.port}.`,
        'info',
        actionDetails(context)
    );
    const currentBot = mineflayer.createBot(options);
    let connectionIssue = null;
    let signedInSuccessfully = false;
    let unexpectedAlertQueued = false;
    bot = currentBot;

    function queueUnexpectedDisconnectAlert(reason) {
        if (shuttingDown || unexpectedAlertQueued) {
            return;
        }

        unexpectedAlertQueued = true;
        void sendUnexpectedDisconnectAlert(reason);
    }

    currentBot.once('login', () => {
        console.log(`Authenticated as ${currentBot.username}.`);
        emitMinecraftEvent(
            'Minecraft Authentication Successful',
            `Authenticated as ${currentBot.username}.`,
            'success',
            {
                Account: currentBot.username,
                Server: options.host
            }
        );
    });

    currentBot.once('spawn', () => {
        signedInSuccessfully = true;
        console.log(`Connected and spawned as ${currentBot.username}. Type "help" for commands.`);
        emitMinecraftEvent(
            'Minecraft Bot Online',
            `Connected and spawned as ${currentBot.username}.`,
            'success',
            {
                Account: currentBot.username,
                Server: options.host,
                Port: options.port
            }
        );
    });

    currentBot.once('death', () => {
        if (cobbleMode?.bot === currentBot) {
            stopCobbleMode(
                {
                    actorTag: 'Minecraft bot',
                    source: 'Death event'
                },
                'Cobble mode stopped because the Minecraft bot died.',
                'warning'
            );
        }
    });

    currentBot.on('whisper', (username, message) => {
        logPrivateMessage(username, message);
    });

    currentBot.on('message', (jsonMessage, position, sender, verified) => {
        const message = jsonMessage.toString();
        console.log(`[${timestamp()}] [Minecraft/${position || 'unknown'}] ${message}`);
        console.log(
            `[${timestamp()}] [Minecraft raw] ${stringifyForLog({
                position: position || null,
                sender: sender || null,
                verified: verified ?? null,
                message: jsonMessage.toJSON ? jsonMessage.toJSON() : jsonMessage
            })}`
        );
        const privateMessage = parsePrivateMessage(message, currentBot.username);
        if (privateMessage) {
            logPrivateMessage(privateMessage.player, privateMessage.message);
        }
        logIncomingPayment(message);
        handlePaymentResponse(message);
        handleBalanceResponse(message);
    });

    currentBot.on('kicked', reason => {
        connectionIssue = `Kicked: ${String(reason)}`;
        console.error(`Minecraft bot was kicked: ${String(reason)}`);
        queueUnexpectedDisconnectAlert(connectionIssue);
        emitMinecraftEvent(
            'Minecraft Bot Kicked',
            'The server kicked the Minecraft bot.',
            'error',
            {
                Reason: String(reason)
            }
        );
    });

    currentBot.on('error', error => {
        connectionIssue = `Error: ${error.message}`;
        console.error(`Minecraft bot error: ${error.message}`);
        emitMinecraftEvent(
            'Minecraft Bot Error',
            error.message,
            'error',
            {
                Stack: error.stack || 'No stack trace available'
            }
        );
    });

    currentBot.once('end', reason => {
        console.log(`Minecraft connection ended: ${reason || 'unknown reason'}`);

        if (bot === currentBot) {
            if (cobbleMode?.bot === currentBot) {
                stopCobbleMode(
                    {
                        actorTag: 'Minecraft bot',
                        source: 'Disconnect'
                    },
                    'Cobble mode stopped because the Minecraft bot disconnected.',
                    'warning'
                );
            }
            cancelPendingPayment('Minecraft disconnected before the payment was confirmed.');
            cancelPendingBalance('Minecraft disconnected before the balance check was confirmed.');
            bot = null;

            if (!signedInSuccessfully) {
                void sendSigninAlert(connectionIssue || reason || 'The bot disconnected before spawning.');
            } else {
                queueUnexpectedDisconnectAlert(connectionIssue || reason || 'The bot disconnected after spawning.');
            }

            emitMinecraftEvent(
                signedInSuccessfully
                    ? 'Minecraft Bot Went Offline Unexpectedly'
                    : 'Minecraft Bot Failed to Start',
                signedInSuccessfully
                    ? 'The Minecraft bot disconnected without a requested shutdown. A random automatic reconnect between 5 and 15 minutes will be scheduled unless the Don uses /bot start sooner.'
                    : 'The Minecraft bot disconnected before it successfully spawned. A random automatic reconnect between 5 and 15 minutes will be scheduled unless the Don uses /bot start sooner.',
                'error',
                {
                    Reason: connectionIssue || reason || 'Unknown reason',
                    Server: options.host
                }
            );

            scheduleReconnect();
        }
    });

    return { status: 'connecting', username: currentBot.username || null };
}

function disconnect() {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    if (bot) {
        if (cobbleMode?.bot === bot) {
            stopCobbleMode(
                {
                    actorTag: 'Minecraft bot',
                    source: 'Disconnect'
                },
                'Cobble mode stopped because the Minecraft bot is disconnecting.'
            );
        }
        cancelPendingPayment('Minecraft disconnected before the payment was confirmed.');
        cancelPendingBalance('Minecraft disconnected before the balance check was confirmed.');
        bot.quit('Minecraft payment bot disconnecting');
        bot = null;
    }
}

function startMinecraftBot(context = {}) {
    return connect(context);
}

function stopMinecraftBot(context = {}) {
    const wasRunning = Boolean(bot || reconnectTimer);
    shuttingDown = true;
    disconnect();

    emitMinecraftEvent(
        wasRunning ? 'Minecraft Bot Stopped' : 'Minecraft Bot Stop Requested',
        wasRunning
            ? 'The Minecraft bot was intentionally disconnected and automatic reconnecting was stopped.'
            : 'The Minecraft bot was already stopped.',
        wasRunning ? 'warning' : 'info',
        actionDetails(context)
    );

    return wasRunning;
}

function minecraftBotStatus() {
    const host = process.env.MINECRAFT_HOST?.trim() || null;

    if (isConnected()) {
        return {
            status: 'connected',
            username: bot.username,
            host
        };
    }

    if (bot) {
        return {
            status: 'connecting',
            username: bot.username || null,
            host
        };
    }

    if (reconnectTimer) {
        return {
            status: 'reconnecting',
            username: null,
            host
        };
    }

    return {
        status: 'stopped',
        username: null,
        host
    };
}

function printHelp() {
    console.log(
        [
            '',
            'Minecraft bot commands:',
            '  help                         Show this command list',
            '  status                       Show connection status',
            '  say <message>                Send text or a command to Minecraft chat',
            '  msg <player> <message>       Send /msg [PLAYER] [message]',
            '  pay <player> <amount>        Send /pay [PLAYER] [AMOUNT]',
            '  bal                          Send /bal and wait for the balance response',
            '  cobble [start|stop|status]   Hold sneak, left click/destroy, and right click/use',
            '  unstuck                      Release held controls and print position/velocity',
            '  reconnect                    Reconnect to the Minecraft server',
            '  quit                         Disconnect and stop this process',
            ''
        ].join('\n')
    );
}

async function handleTerminalCommand(input) {
    const trimmed = input.trim();

    if (!trimmed) {
        return;
    }

    const [command, ...args] = trimmed.split(/\s+/);

    try {
        if (command === 'help') {
            printHelp();
        } else if (command === 'status') {
            console.log(
                isConnected()
                    ? `Connected as ${bot.username} to ${bot._client.socket.remoteAddress}.`
                    : 'Not connected.'
            );
        } else if (command === 'say') {
            const message = args.join(' ');

            if (!message) {
                throw new Error('Usage: say <message>');
            }

            await sendChat(message);
            console.log(`Chat sent: ${message}`);
        } else if (command === 'pay') {
            if (args.length !== 2) {
                throw new Error('Usage: pay <player> <amount>');
            }

            const result = await payPlayer(args[0], args[1]);
            console.log(`Payment completed: ${result.message}`);
        } else if (command === 'bal' || command === 'balance') {
            const result = await checkBalance();
            console.log(`Balance: ${result.amount.toString()} (${result.message})`);
        } else if (command === 'msg') {
            if (args.length < 2) {
                throw new Error('Usage: msg <player> <message>');
            }

            await messagePlayer(args[0], args.slice(1).join(' '));
        } else if (command === 'cobble') {
            const action = (args[0] || 'start').toLowerCase();

            if (action === 'start') {
                const result = startCobbleMode({
                    actorTag: 'Terminal',
                    source: 'Terminal command'
                });
                console.log(result.started ? 'Cobble mode started.' : 'Cobble mode is already running.');
            } else if (action === 'stop') {
                const result = stopCobbleMode({
                    actorTag: 'Terminal',
                    source: 'Terminal command'
                }, 'Cobble mode was stopped from the terminal.');
                console.log(result.stopped ? 'Cobble mode stopped.' : 'Cobble mode is not running.');
            } else if (action === 'status') {
                console.log(JSON.stringify(cobbleModeStatus(), null, 2));
            } else {
                throw new Error('Usage: cobble [start|stop|status]');
            }
        } else if (command === 'unstuck') {
            const result = resetMinecraftBotControls({
                actorTag: 'Terminal',
                source: 'Terminal command'
            });
            console.log(
                `Controls reset. Position=${formatVectorSnapshot(result.position)} ` +
                `Velocity=${formatVectorSnapshot(result.velocity)}`
            );
        } else if (command === 'reconnect') {
            disconnect();
            connect();
        } else if (command === 'quit' || command === 'exit') {
            shuttingDown = true;
            disconnect();
            process.exit(0);
        } else {
            console.log(`Unknown command: ${command}. Type "help" for commands.`);
        }
    } catch (error) {
        console.error(`Command failed: ${error.message}`);
    }
}

function startTerminal() {
    const terminal = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: true
    });

    terminal.on('line', input => {
        handleTerminalCommand(input).catch(error => {
            console.error(`Command failed: ${error.message}`);
        });
    });
    terminal.on('close', () => {
        shuttingDown = true;
        disconnect();
    });

    process.on('SIGINT', () => {
        terminal.close();
        process.exit(0);
    });

    printHelp();
    connect();
}

if (require.main === module) {
    try {
        startTerminal();
    } catch (error) {
        console.error(`Minecraft bot could not start: ${error.message}`);
        process.exitCode = 1;
    }
}

module.exports = {
    alertCooldownMs,
    buildMessageCommand,
    buildBalanceCommand,
    buildBalanceCommands,
    buildPaymentCommand,
    checkBalance,
    classifyBalanceFailure,
    classifyBalanceResponse,
    classifyPaymentResponse,
    cleanMinecraftMessage,
    cobbleModeStatus,
    minecraftOptions,
    handleTerminalCommand,
    goHome,
    goHomeNumber,
    logIncomingPayment,
    messagePlayer,
    emitMinecraftEvent,
    minecraftEvents,
    parseIncomingPayment,
    parsePrivateMessage,
    resetMinecraftBotControls,
    microsoftLoginAlert,
    microsoftOneClickLoginUrl,
    minecraftBotStatus,
    sendMinecraftAlert,
    payPlayer,
    randomReconnectDelayMinutes,
    sendSigninAlert,
    sendUnexpectedDisconnectAlert,
    sendTwilioSms,
    smsAlertConfiguration,
    startCobbleMode,
    startMinecraftBot,
    stopCobbleMode,
    stopMinecraftBot,
    validatePaymentAmount,
    validatePlayer
};
