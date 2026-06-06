const fs = require('fs');
const path = require('path');

const localFontConfig = path.join(__dirname, '..', 'fontconfig', 'fonts.conf');

if (!process.env.FONTCONFIG_FILE && fs.existsSync(localFontConfig)) {
    process.env.FONTCONFIG_FILE = localFontConfig;
}

if (!process.env.FONTCONFIG_PATH && fs.existsSync(path.dirname(localFontConfig))) {
    process.env.FONTCONFIG_PATH = path.dirname(localFontConfig);
}

const sharp = require('sharp');

const RANK_STYLES = {
    'Penguin Soldier': {
        color: '#5DADE2',
        label: 'Soldier'
    },
    'Penguin Captain': {
        color: '#58D68D',
        label: 'Captain'
    },
    'Penguin General': {
        color: '#F4D03F',
        label: 'General'
    },
    'Emperor Penguin': {
        color: '#AF7AC5',
        label: 'Emperor'
    }
};
const MAX_FULL_PLAYER_CARDS = 50;
const RANK_PRIORITY = new Map([
    ['Penguin Soldier', 0],
    ['Penguin Captain', 1],
    ['Penguin General', 2],
    ['Emperor Penguin', 3]
]);

function playerName(player, fallback = 'Unknown Player') {
    return player.minecraft_ign ||
        player.discord_display_name ||
        player.discord_username ||
        fallback;
}

function escapeXml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function safeSvgText(value, fallback = 'Unknown Player') {
    const text = String(value ?? '')
        .normalize('NFKD')
        .replace(/[^\x20-\x7E]/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    return text || fallback;
}

function truncateText(value, maxLength) {
    const text = String(value ?? '');

    if (text.length <= maxLength) {
        return text;
    }

    return `${text.slice(0, maxLength - 3)}...`;
}

function compareNodesByBranchSize(first, second) {
    if (second.subtreeSize !== first.subtreeSize) {
        return second.subtreeSize - first.subtreeSize;
    }

    const firstRankPriority = RANK_PRIORITY.get(first.player?.rank_name) ?? -1;
    const secondRankPriority = RANK_PRIORITY.get(second.player?.rank_name) ?? -1;

    if (secondRankPriority !== firstRankPriority) {
        return secondRankPriority - firstRankPriority;
    }

    return playerName(first.player).localeCompare(playerName(second.player));
}

function buildHierarchy(root, recruits) {
    const childrenByRecruiter = new Map();

    for (const recruit of recruits) {
        const siblings = childrenByRecruiter.get(recruit.parent_discord_id) || [];
        siblings.push(recruit);
        childrenByRecruiter.set(recruit.parent_discord_id, siblings);
    }

    function makeNode(player, depth = 0) {
        const node = {
            player,
            depth,
            children: (childrenByRecruiter.get(player.discord_id) || []).map(child => makeNode(child, depth + 1))
        };

        node.subtreeSize = 1 + node.children.reduce((sum, child) => sum + child.subtreeSize, 0);
        node.children.sort(compareNodesByBranchSize);

        return node;
    }

    return makeNode(root);
}

function selectVisiblePlayerIds(rootNode) {
    const visibleIds = new Set([rootNode.player.discord_id]);
    const queue = [...rootNode.children];

    while (queue.length > 0 && visibleIds.size < MAX_FULL_PLAYER_CARDS) {
        queue.sort(compareNodesByBranchSize);

        const node = queue.shift();
        visibleIds.add(node.player.discord_id);
        queue.push(...node.children);
    }

    return visibleIds;
}

function createOverflowNode(parentNode, hiddenCount) {
    return {
        depth: parentNode.depth + 1,
        isOverflow: true,
        hiddenCount,
        children: []
    };
}

function buildDisplayTree(fullNode, visibleIds) {
    const displayNode = {
        player: fullNode.player,
        depth: fullNode.depth,
        children: []
    };
    let hiddenCount = 0;

    for (const child of fullNode.children) {
        if (visibleIds.has(child.player.discord_id)) {
            displayNode.children.push(buildDisplayTree(child, visibleIds));
        } else {
            hiddenCount += child.subtreeSize;
        }
    }

    if (hiddenCount > 0) {
        displayNode.children.push(createOverflowNode(displayNode, hiddenCount));
    }

    return displayNode;
}

function prepareDisplayTree(root, recruits) {
    const fullTree = buildHierarchy(root, recruits);
    const visibleIds = recruits.length + 1 > MAX_FULL_PLAYER_CARDS
        ? selectVisiblePlayerIds(fullTree)
        : new Set(collectNodes(fullTree).map(node => node.player.discord_id));

    return buildDisplayTree(fullTree, visibleIds);
}

function collectNodes(rootNode) {
    const nodes = [];

    function walk(node) {
        nodes.push(node);
        node.children.forEach(walk);
    }

    walk(rootNode);
    return nodes;
}

function polarToCartesian(centerX, centerY, radius, angle) {
    return {
        x: centerX + Math.cos(angle) * radius,
        y: centerY + Math.sin(angle) * radius
    };
}

function countLeaves(node) {
    if (node.children.length === 0) {
        return 1;
    }

    node.leafCount = node.children.reduce((sum, child) => sum + countLeaves(child), 0);
    return node.leafCount;
}

function maxDepth(node) {
    if (node.children.length === 0) {
        return node.depth;
    }

    return Math.max(...node.children.map(maxDepth));
}

function nodeSize(node) {
    if (node.isOverflow) {
        return {
            width: 170,
            height: 78
        };
    }

    return {
        width: 245,
        height: 130
    };
}

function relaxNodeOverlaps(nodes, rootNode) {
    const rootId = rootNode.player.discord_id;

    for (let iteration = 0; iteration < 90; iteration++) {
        let moved = false;

        for (let a = 0; a < nodes.length; a++) {
            for (let b = a + 1; b < nodes.length; b++) {
                const first = nodes[a];
                const second = nodes[b];
                const firstSize = nodeSize(first);
                const secondSize = nodeSize(second);
                const minX = (firstSize.width + secondSize.width) / 2 + 28;
                const minY = (firstSize.height + secondSize.height) / 2 + 24;
                let dx = second.x - first.x;
                let dy = second.y - first.y;
                const overlapX = minX - Math.abs(dx);
                const overlapY = minY - Math.abs(dy);

                if (overlapX <= 0 || overlapY <= 0) {
                    continue;
                }

                if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) {
                    dx = 1;
                    dy = 1;
                }

                const firstLocked = first.player?.discord_id === rootId;
                const secondLocked = second.player?.discord_id === rootId;
                const pushX = Math.sign(dx) * (overlapX / (firstLocked || secondLocked ? 1 : 2) + 12);
                const pushY = Math.sign(dy) * (overlapY / (firstLocked || secondLocked ? 1 : 2) + 10);

                if (overlapX < overlapY) {
                    if (!firstLocked) first.x -= pushX;
                    if (!secondLocked) second.x += pushX;
                } else {
                    if (!firstLocked) first.y -= pushY;
                    if (!secondLocked) second.y += pushY;
                }

                moved = true;
            }
        }

        if (!moved) {
            break;
        }
    }
}

function layoutTree(rootNode) {
    countLeaves(rootNode);

    const nodeCount = collectNodes(rootNode).length;
    const depth = Math.max(1, maxDepth(rootNode));
    const ringGap = nodeCount <= 16
        ? 360
        : nodeCount <= 36 ? 320 : 280;
    const minCanvasWidth = nodeCount <= 16
        ? 1800
        : nodeCount <= 36 ? 2100 : 2400;
    const minCanvasHeight = nodeCount <= 16
        ? 1680
        : nodeCount <= 36 ? 1900 : 2200;
    const baseWidth = Math.max(minCanvasWidth, Math.min(3400, 680 + depth * ringGap * 2));
    const baseHeight = Math.max(minCanvasHeight, Math.min(3200, 620 + depth * ringGap * 2));
    let centerX = baseWidth / 2;
    let centerY = baseHeight / 2 + (nodeCount <= 16 ? 70 : 44);
    const firstRing = nodeCount <= 16
        ? 430
        : nodeCount <= 36 ? 380 : ringGap;

    rootNode.x = centerX;
    rootNode.y = centerY;

    function assignChildren(node, startAngle, endAngle) {
        let cursor = startAngle;
        const totalLeaves = node.children.reduce((sum, child) => sum + (child.leafCount || 1), 0) || 1;

        for (const child of node.children) {
            const childShare = (child.leafCount || 1) / totalLeaves;
            const childSpan = (endAngle - startAngle) * childShare;
            const childStart = cursor;
            const childEnd = cursor + childSpan;
            const angle = (childStart + childEnd) / 2;
            const radius = child.depth === 1
                ? firstRing
                : firstRing + (child.depth - 1) * ringGap;
            const point = polarToCartesian(centerX, centerY, radius, angle);

            child.x = point.x;
            child.y = point.y;
            child.angle = angle;

            assignChildren(child, childStart, childEnd);
            cursor += childSpan;
        }
    }

    assignChildren(rootNode, -Math.PI / 2, Math.PI * 1.5);

    const nodes = collectNodes(rootNode);
    relaxNodeOverlaps(nodes, rootNode);
    const minX = Math.min(...nodes.map(node => node.x - (node.isOverflow ? 70 : 95)));
    const maxX = Math.max(...nodes.map(node => node.x + (node.isOverflow ? 70 : 95)));
    const minY = Math.min(...nodes.map(node => node.y - (node.isOverflow ? 42 : 72)));
    const maxY = Math.max(...nodes.map(node => node.y + (node.isOverflow ? 42 : 72)));
    const leftPadding = 130;
    const rightPadding = 130;
    const topPadding = 190;
    const bottomPadding = 150;
    const contentWidth = maxX - minX + leftPadding + rightPadding;
    const contentHeight = maxY - minY + topPadding + bottomPadding;
    const width = Math.max(minCanvasWidth, Math.ceil(contentWidth));
    const height = Math.max(minCanvasHeight, Math.ceil(contentHeight));
    const shiftX = leftPadding + (width - contentWidth) / 2 - minX;
    const shiftY = topPadding + (height - contentHeight) / 2 - minY;

    for (const node of nodes) {
        node.x += shiftX;
        node.y += shiftY;
    }

    centerX += shiftX;
    centerY += shiftY;

    return {
        nodes,
        width,
        height,
        centerX,
        centerY,
        ringGap,
        firstRing
    };
}

function connectionPath(parent, child) {
    const dx = child.x - parent.x;
    const dy = child.y - parent.y;
    const distance = Math.max(1, Math.sqrt(dx * dx + dy * dy));
    const parentOffset = parent.depth === 0 ? 58 : 74;
    const childOffset = child.isOverflow ? 38 : 78;
    const startX = parent.x + (dx / distance) * parentOffset;
    const startY = parent.y + (dy / distance) * parentOffset;
    const endX = child.x - (dx / distance) * childOffset;
    const endY = child.y - (dy / distance) * childOffset;
    const midX = (startX + endX) / 2;
    const midY = (startY + endY) / 2;

    return `M ${startX} ${startY} Q ${midX} ${midY} ${endX} ${endY}`;
}

function renderNode(node) {
    if (node.isOverflow) {
        return renderOverflowNode(node);
    }

    const width = 162;
    const height = 78;
    const x = node.x - width / 2;
    const y = node.y - height / 2;
    const rankStyle = RANK_STYLES[node.player.rank_name] || RANK_STYLES['Penguin Soldier'];
    const name = truncateText(safeSvgText(playerName(node.player, node.player.discord_username)), 13);
    const rank = rankStyle.label;

    return `
        <g filter="url(#softShadow)">
            <rect x="${x}" y="${y}" width="${width}" height="${height}" rx="18" fill="#111827" stroke="${rankStyle.color}" stroke-width="2.5"/>
            <rect x="${x + 9}" y="${y + 9}" width="${width - 18}" height="${height - 18}" rx="14" fill="#1C2433" opacity="0.72"/>
            <rect x="${x}" y="${y}" width="7" height="${height}" rx="3.5" fill="${rankStyle.color}"/>
            <ellipse cx="${x + 31}" cy="${y + 31}" rx="15" ry="18" fill="#0B1220" stroke="${rankStyle.color}" stroke-width="2"/>
            <ellipse cx="${x + 31}" cy="${y + 34}" rx="8" ry="10" fill="#F8FAFC"/>
            <circle cx="${x + 26}" cy="${y + 27}" r="1.8" fill="#F8FAFC"/>
            <circle cx="${x + 36}" cy="${y + 27}" r="1.8" fill="#F8FAFC"/>
            <path d="M ${x + 28} ${y + 31} L ${x + 31} ${y + 34} L ${x + 34} ${y + 31} Z" fill="#F59E0B"/>
            <text x="${x + 54}" y="${y + 32}" fill="#F4F7FB" font-size="16" font-weight="700">${escapeXml(name)}</text>
            <text x="${x + 50}" y="${y + 55}" fill="#A9B0C3" font-size="12" font-weight="700" letter-spacing="1">${escapeXml(rank.toUpperCase())}</text>
        </g>
    `;
}

function renderOverflowNode(node) {
    const width = 118;
    const height = 46;
    const x = node.x - width / 2;
    const y = node.y - height / 2;
    const dotY = y + 18;
    const dotStartX = x + 25;

    return `
        <g filter="url(#softShadow)">
            <path d="M ${x + 8} ${y + height - 8} L ${x + 28} ${y + 8} L ${x + 78} ${y + 4} L ${x + width - 7} ${y + height - 11} Z" fill="#DDF8FF" opacity="0.9" stroke="#7DD3FC" stroke-width="2" stroke-dasharray="5 5"/>
            <circle cx="${dotStartX}" cy="${dotY}" r="4.5" fill="#0284C7"/>
            <circle cx="${dotStartX + 14}" cy="${dotY}" r="4.5" fill="#0EA5E9" opacity="0.75"/>
            <circle cx="${dotStartX + 28}" cy="${dotY}" r="4.5" fill="#38BDF8" opacity="0.65"/>
            <text x="${x + width / 2}" y="${y + 35}" text-anchor="middle" fill="#E5E7EB" font-size="13" font-weight="700">+${node.hiddenCount}</text>
        </g>
    `;
}

function renderSnow(width, height) {
    const flakes = [
        [70, 130, 2], [150, 44, 1.5], [260, 112, 2.2], [410, 72, 1.7],
        [width - 90, 150, 2.1], [width - 220, 62, 1.6], [width - 350, 120, 2],
        [90, height - 120, 1.8], [width - 160, height - 90, 2.2], [width / 2, height - 64, 1.5]
    ];

    return flakes.map(([x, y, r]) => {
        return `<circle cx="${x}" cy="${y}" r="${r}" fill="#E0F2FE" opacity="0.58"/>`;
    }).join('');
}

function renderIceShelf(width, height) {
    return `
        <path d="M 0 ${height - 86} C ${width * 0.18} ${height - 126}, ${width * 0.35} ${height - 50}, ${width * 0.52} ${height - 88} C ${width * 0.72} ${height - 132}, ${width * 0.83} ${height - 48}, ${width} ${height - 90} L ${width} ${height} L 0 ${height} Z" fill="#DDF8FF" opacity="0.11"/>
        <path d="M 34 ${height - 58} L 114 ${height - 118} L 224 ${height - 74} L 312 ${height - 132} L 410 ${height - 56} Z" fill="#BAE6FD" opacity="0.10"/>
        <path d="M ${width - 390} ${height - 54} L ${width - 270} ${height - 128} L ${width - 182} ${height - 72} L ${width - 82} ${height - 116} L ${width - 18} ${height - 54} Z" fill="#CFFAFE" opacity="0.10"/>
    `;
}

function renderRadialGuides(centerX, centerY, base) {

    return `
        <circle cx="${centerX}" cy="${centerY}" r="${base}" fill="none" stroke="#7DD3FC" stroke-width="1.5" opacity="0.12"/>
        <circle cx="${centerX}" cy="${centerY}" r="${base * 2}" fill="none" stroke="#7DD3FC" stroke-width="1.5" opacity="0.08"/>
        <circle cx="${centerX}" cy="${centerY}" r="${base * 3}" fill="none" stroke="#7DD3FC" stroke-width="1.5" opacity="0.05"/>
    `;
}

function renderLegend(width) {
    const items = Object.entries(RANK_STYLES);
    const startX = Math.max(40, width - 650);

    return items.map(([rank, style], index) => {
        const x = startX + index * 150;

        return `
            <g>
                <circle cx="${x}" cy="104" r="7" fill="${style.color}"/>
                <text x="${x + 14}" y="109" fill="#CBD2E1" font-size="12" font-weight="700">${escapeXml(style.label)}</text>
            </g>
        `;
    }).join('');
}

function renderSvg(root, recruits) {
    const rootNode = prepareDisplayTree(root, recruits);
    const {
        nodes,
        width,
        height,
        centerX,
        centerY,
        firstRing
    } = layoutTree(rootNode);
    const rootName = truncateText(safeSvgText(playerName(root)), 28);
    const fullCardCount = nodes.filter(node => !node.isOverflow).length;
    const hiddenCount = Math.max(0, recruits.length + 1 - fullCardCount);
    const clippedNotice = hiddenCount > 0
        ? `<text x="40" y="${height - 34}" fill="#F59E0B" font-size="13" font-weight="700">Large tree: biggest branches shown as cards. Dot clusters represent ${hiddenCount} hidden recruit${hiddenCount === 1 ? '' : 's'}.</text>`
        : '';

    const links = nodes.flatMap(node => {
        return node.children.map(child => {
            return `<path d="${connectionPath(node, child)}" fill="none" stroke="#394154" stroke-width="3" stroke-linecap="round"/>`;
        });
    }).join('');

    return `
        <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
            <defs>
                <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0%" stop-color="#061524"/>
                    <stop offset="52%" stop-color="#0F1B2D"/>
                    <stop offset="100%" stop-color="#071F2A"/>
                </linearGradient>
                <radialGradient id="glow" cx="50%" cy="0%" r="70%">
                    <stop offset="0%" stop-color="#7DD3FC" stop-opacity="0.32"/>
                    <stop offset="100%" stop-color="#7DD3FC" stop-opacity="0"/>
                </radialGradient>
                <filter id="softShadow" x="-20%" y="-20%" width="140%" height="150%">
                    <feDropShadow dx="0" dy="12" stdDeviation="10" flood-color="#000000" flood-opacity="0.32"/>
                </filter>
                <style>
                    text { font-family: "DejaVu Sans", "Liberation Sans", Arial, Helvetica, sans-serif; font-style: normal; }
                </style>
            </defs>
            <rect width="${width}" height="${height}" fill="url(#bg)"/>
            <rect width="${width}" height="${height}" fill="url(#glow)"/>
            ${renderSnow(width, height)}
            <circle cx="${width - 120}" cy="80" r="220" fill="#7DD3FC" opacity="0.10"/>
            <circle cx="90" cy="${height - 80}" r="260" fill="#E0F2FE" opacity="0.08"/>
            ${renderIceShelf(width, height)}
            ${renderRadialGuides(centerX, centerY, firstRing)}
            <text x="40" y="56" fill="#FFFFFF" font-size="30" font-weight="700">Penguin Mafia Recruit Graph</text>
            <text x="40" y="88" fill="#A9B0C3" font-size="15" font-weight="700">${escapeXml(rootName)} - ${recruits.length} total recruit${recruits.length === 1 ? '' : 's'}</text>
            ${renderLegend(width)}
            <g opacity="0.96">${links}</g>
            ${nodes.map(renderNode).join('')}
            ${clippedNotice}
        </svg>
    `;
}

async function renderRecruitTreeImage(root, recruits) {
    const svg = renderSvg(root, recruits);

    return sharp(Buffer.from(svg))
        .png()
        .toBuffer();
}

module.exports = {
    renderRecruitTreeImage
};
