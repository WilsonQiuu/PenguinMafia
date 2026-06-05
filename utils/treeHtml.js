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

const MAX_FULL_PLAYER_CARDS = 120;

function playerName(player, fallback = 'Unknown Player') {
    return player.minecraft_ign ||
        player.discord_display_name ||
        player.discord_username ||
        fallback;
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function truncateText(value, maxLength) {
    const text = String(value ?? '');

    if (text.length <= maxLength) {
        return text;
    }

    return `${text.slice(0, maxLength - 1)}…`;
}

function buildHierarchy(root, recruits) {
    const childrenByRecruiter = new Map();

    for (const recruit of recruits) {
        const siblings = childrenByRecruiter.get(recruit.parent_discord_id) || [];
        siblings.push(recruit);
        childrenByRecruiter.set(recruit.parent_discord_id, siblings);
    }

    for (const siblings of childrenByRecruiter.values()) {
        siblings.sort((a, b) => playerName(a).localeCompare(playerName(b)));
    }

    function makeNode(player, depth = 0) {
        const node = {
            player,
            depth,
            children: (childrenByRecruiter.get(player.discord_id) || []).map(child => makeNode(child, depth + 1))
        };

        node.subtreeSize = 1 + node.children.reduce((sum, child) => sum + child.subtreeSize, 0);
        return node;
    }

    return makeNode(root);
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

function selectVisiblePlayerIds(rootNode) {
    const visibleIds = new Set([rootNode.player.discord_id]);
    const queue = [...rootNode.children];

    while (queue.length > 0 && visibleIds.size < MAX_FULL_PLAYER_CARDS) {
        queue.sort((a, b) => {
            if (b.subtreeSize !== a.subtreeSize) {
                return b.subtreeSize - a.subtreeSize;
            }

            return playerName(a.player).localeCompare(playerName(b.player));
        });

        const node = queue.shift();
        visibleIds.add(node.player.discord_id);
        queue.push(...node.children);
    }

    return visibleIds;
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
        displayNode.children.push({
            depth: displayNode.depth + 1,
            isOverflow: true,
            hiddenCount,
            children: []
        });
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

function countLeaves(node) {
    if (node.children.length === 0) {
        node.leafCount = 1;
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

function polarToCartesian(centerX, centerY, radius, angle) {
    return {
        x: centerX + Math.cos(angle) * radius,
        y: centerY + Math.sin(angle) * radius
    };
}

function layoutTree(rootNode) {
    countLeaves(rootNode);

    const depth = Math.max(1, maxDepth(rootNode));
    const ringGap = 230;
    const width = Math.max(1200, Math.min(3400, 680 + depth * ringGap * 2));
    const height = Math.max(900, Math.min(3000, 560 + depth * ringGap * 2));
    const centerX = width / 2;
    const centerY = height / 2 + 35;

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
            const radius = 230 + Math.max(0, child.depth - 1) * ringGap;
            const point = polarToCartesian(centerX, centerY, radius, angle);

            child.x = point.x;
            child.y = point.y;
            child.angle = angle;
            assignChildren(child, childStart, childEnd);
            cursor += childSpan;
        }
    }

    assignChildren(rootNode, -Math.PI / 2, Math.PI * 1.5);

    return {
        nodes: collectNodes(rootNode),
        width,
        height,
        centerX,
        centerY,
        depth
    };
}

function flattenLinks(nodes) {
    const links = [];

    for (const node of nodes) {
        for (const child of node.children) {
            links.push({
                source: node,
                target: child
            });
        }
    }

    return links;
}

function nodePayload(node) {
    if (node.isOverflow) {
        return {
            isOverflow: true,
            hiddenCount: node.hiddenCount,
            x: node.x,
            y: node.y,
            depth: node.depth
        };
    }

    const style = RANK_STYLES[node.player.rank_name] || RANK_STYLES['Penguin Soldier'];

    return {
        id: node.player.discord_id,
        name: playerName(node.player, node.player.discord_username),
        label: truncateText(playerName(node.player, node.player.discord_username), 18),
        rank: node.player.rank_name,
        rankLabel: style.label,
        color: style.color,
        x: node.x,
        y: node.y,
        depth: node.depth,
        recruits: node.children.reduce((sum, child) => {
            return sum + (child.isOverflow ? child.hiddenCount : 1);
        }, 0)
    };
}

function renderRecruitTreeHtml(root, recruits) {
    const displayTree = prepareDisplayTree(root, recruits);
    const layout = layoutTree(displayTree);
    const payload = {
        rootName: playerName(root),
        totalRecruits: recruits.length,
        width: layout.width,
        height: layout.height,
        centerX: layout.centerX,
        centerY: layout.centerY,
        depth: layout.depth,
        nodes: layout.nodes.map(nodePayload),
        links: flattenLinks(layout.nodes).map(link => ({
            source: nodePayload(link.source),
            target: nodePayload(link.target)
        })),
        ranks: RANK_STYLES
    };

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Penguin Mafia Recruit Graph</title>
<style>
    :root {
        color-scheme: dark;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #061524;
    }

    * {
        box-sizing: border-box;
    }

    body {
        margin: 0;
        min-height: 100vh;
        overflow: hidden;
        background:
            radial-gradient(circle at 50% 8%, rgba(125, 211, 252, 0.28), transparent 36%),
            radial-gradient(circle at 8% 90%, rgba(224, 242, 254, 0.09), transparent 28%),
            linear-gradient(135deg, #061524 0%, #0f1b2d 52%, #071f2a 100%);
        color: #f8fafc;
    }

    header {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        z-index: 5;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 18px;
        padding: 22px 28px;
        background: linear-gradient(180deg, rgba(6, 21, 36, 0.94), rgba(6, 21, 36, 0));
        pointer-events: none;
    }

    h1 {
        margin: 0;
        font-size: clamp(24px, 3vw, 42px);
        letter-spacing: 0;
    }

    .subtitle {
        margin-top: 5px;
        color: #a9b0c3;
        font-weight: 700;
    }

    .legend {
        display: flex;
        flex-wrap: wrap;
        gap: 12px 18px;
        justify-content: flex-end;
        color: #cbd5e1;
        font-size: 13px;
        font-weight: 800;
    }

    .legend span {
        display: inline-flex;
        align-items: center;
        gap: 8px;
    }

    .legend i {
        width: 11px;
        height: 11px;
        border-radius: 999px;
        display: inline-block;
    }

    .stage {
        width: 100vw;
        height: 100vh;
        overflow: auto;
        cursor: grab;
    }

    .stage:active {
        cursor: grabbing;
    }

    svg {
        display: block;
        min-width: 100vw;
        min-height: 100vh;
    }

    .ice-ring {
        fill: none;
        stroke: #7dd3fc;
        opacity: 0.09;
        stroke-width: 2;
    }

    .link {
        fill: none;
        stroke: rgba(148, 163, 184, 0.45);
        stroke-width: 3;
        stroke-linecap: round;
        transition: stroke 140ms ease, stroke-width 140ms ease, opacity 140ms ease;
    }

    .node-card {
        filter: drop-shadow(0 12px 12px rgba(0, 0, 0, 0.34));
        cursor: pointer;
        transition: transform 140ms ease, opacity 140ms ease;
    }

    .node-card:hover {
        transform: scale(1.05);
    }

    .card-bg {
        fill: #111827;
        stroke-width: 2.5;
    }

    .card-inner {
        fill: #1c2433;
        opacity: 0.76;
    }

    .penguin-body {
        fill: #0b1220;
        stroke-width: 2;
    }

    .penguin-belly,
    .penguin-eye {
        fill: #f8fafc;
    }

    .penguin-beak {
        fill: #f59e0b;
    }

    .node-name {
        fill: #f4f7fb;
        font-size: 16px;
        font-weight: 900;
    }

    .node-rank {
        fill: #a9b0c3;
        font-size: 12px;
        font-weight: 900;
        letter-spacing: 1px;
    }

    .overflow-ice {
        fill: rgba(221, 248, 255, 0.9);
        stroke: #7dd3fc;
        stroke-width: 2;
        stroke-dasharray: 5 5;
        filter: drop-shadow(0 12px 12px rgba(0, 0, 0, 0.26));
    }

    .tooltip {
        position: fixed;
        z-index: 10;
        min-width: 210px;
        max-width: 280px;
        padding: 13px 14px;
        border: 1px solid rgba(125, 211, 252, 0.35);
        border-radius: 12px;
        background: rgba(10, 18, 32, 0.95);
        box-shadow: 0 16px 36px rgba(0, 0, 0, 0.34);
        color: #f8fafc;
        opacity: 0;
        transform: translateY(6px);
        transition: opacity 120ms ease, transform 120ms ease;
        pointer-events: none;
    }

    .tooltip.visible {
        opacity: 1;
        transform: translateY(0);
    }

    .tooltip strong {
        display: block;
        margin-bottom: 6px;
        font-size: 16px;
    }

    .tooltip div {
        color: #cbd5e1;
        font-size: 13px;
        font-weight: 700;
        line-height: 1.45;
    }

    .hint {
        position: fixed;
        left: 28px;
        bottom: 22px;
        color: #93a4bb;
        font-size: 13px;
        font-weight: 800;
        background: rgba(8, 15, 28, 0.64);
        border: 1px solid rgba(148, 163, 184, 0.18);
        border-radius: 999px;
        padding: 8px 12px;
    }
</style>
</head>
<body>
<header>
    <div>
        <h1>Penguin Mafia Recruit Graph</h1>
        <div class="subtitle">${escapeHtml(payload.rootName)} • ${payload.totalRecruits} total recruit${payload.totalRecruits === 1 ? '' : 's'}</div>
    </div>
    <div class="legend">
        ${Object.entries(RANK_STYLES).map(([rank, style]) => `<span><i style="background:${style.color}"></i>${escapeHtml(style.label)}</span>`).join('')}
    </div>
</header>
<main class="stage" id="stage">
    <svg id="graph" width="${payload.width}" height="${payload.height}" viewBox="0 0 ${payload.width} ${payload.height}" xmlns="http://www.w3.org/2000/svg"></svg>
</main>
<div class="tooltip" id="tooltip"></div>
<div class="hint">Hover nodes for names • Drag/scroll to explore</div>
<script>
const graphData = ${JSON.stringify(payload)};
const svg = document.getElementById('graph');
const stage = document.getElementById('stage');
const tooltip = document.getElementById('tooltip');
const SVG_NS = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}) {
    const node = document.createElementNS(SVG_NS, name);
    for (const [key, value] of Object.entries(attrs)) {
        node.setAttribute(key, value);
    }
    return node;
}

function connectionPath(source, target) {
    const dx = target.x - source.x;
    const dy = target.y - source.y;
    const distance = Math.max(1, Math.sqrt(dx * dx + dy * dy));
    const sourceOffset = source.depth === 0 ? 58 : 74;
    const targetOffset = target.isOverflow ? 38 : 78;
    const startX = source.x + (dx / distance) * sourceOffset;
    const startY = source.y + (dy / distance) * sourceOffset;
    const endX = target.x - (dx / distance) * targetOffset;
    const endY = target.y - (dy / distance) * targetOffset;
    const midX = (startX + endX) / 2;
    const midY = (startY + endY) / 2;
    return 'M ' + startX + ' ' + startY + ' Q ' + midX + ' ' + midY + ' ' + endX + ' ' + endY;
}

function text(parent, x, y, value, className, attrs = {}) {
    const t = el('text', { x, y, class: className, ...attrs });
    t.textContent = value;
    parent.appendChild(t);
    return t;
}

function renderBackground() {
    svg.appendChild(el('rect', { width: graphData.width, height: graphData.height, fill: 'transparent' }));
    for (const radius of [230, 460, 690, 920]) {
        svg.appendChild(el('circle', { cx: graphData.centerX, cy: graphData.centerY, r: radius, class: 'ice-ring' }));
    }
}

function renderLinks() {
    const group = el('g');
    for (const link of graphData.links) {
        group.appendChild(el('path', { d: connectionPath(link.source, link.target), class: 'link' }));
    }
    svg.appendChild(group);
}

function penguinIcon(group, x, y, color) {
    group.appendChild(el('ellipse', { cx: x, cy: y + 1, rx: 15, ry: 18, class: 'penguin-body', stroke: color }));
    group.appendChild(el('ellipse', { cx: x, cy: y + 5, rx: 8, ry: 10, class: 'penguin-belly' }));
    group.appendChild(el('circle', { cx: x - 5, cy: y - 6, r: 1.8, class: 'penguin-eye' }));
    group.appendChild(el('circle', { cx: x + 5, cy: y - 6, r: 1.8, class: 'penguin-eye' }));
    group.appendChild(el('path', { d: 'M ' + (x - 3) + ' ' + (y - 2) + ' L ' + x + ' ' + (y + 1) + ' L ' + (x + 3) + ' ' + (y - 2) + ' Z', class: 'penguin-beak' }));
}

function renderOverflow(node) {
    const g = el('g', { class: 'node-card' });
    const x = node.x - 59;
    const y = node.y - 23;
    g.appendChild(el('path', { d: 'M ' + (x + 8) + ' ' + (y + 38) + ' L ' + (x + 28) + ' ' + (y + 8) + ' L ' + (x + 78) + ' ' + (y + 4) + ' L ' + (x + 111) + ' ' + (y + 35) + ' Z', class: 'overflow-ice' }));
    g.appendChild(el('circle', { cx: x + 25, cy: y + 18, r: 4.5, fill: '#0284C7' }));
    g.appendChild(el('circle', { cx: x + 39, cy: y + 18, r: 4.5, fill: '#0EA5E9', opacity: 0.75 }));
    g.appendChild(el('circle', { cx: x + 53, cy: y + 18, r: 4.5, fill: '#38BDF8', opacity: 0.65 }));
    text(g, node.x, y + 35, '+' + node.hiddenCount, 'node-rank', { 'text-anchor': 'middle' });
    g.addEventListener('mouseenter', event => showTooltip(event, '<strong>Hidden recruits</strong><div>' + node.hiddenCount + ' more player' + (node.hiddenCount === 1 ? '' : 's') + ' in this branch.</div>'));
    g.addEventListener('mousemove', moveTooltip);
    g.addEventListener('mouseleave', hideTooltip);
    svg.appendChild(g);
}

function renderPlayer(node) {
    const g = el('g', { class: 'node-card' });
    const width = 162;
    const height = 78;
    const x = node.x - width / 2;
    const y = node.y - height / 2;
    g.appendChild(el('rect', { x, y, width, height, rx: 18, class: 'card-bg', stroke: node.color }));
    g.appendChild(el('rect', { x: x + 9, y: y + 9, width: width - 18, height: height - 18, rx: 14, class: 'card-inner' }));
    g.appendChild(el('rect', { x, y, width: 7, height, rx: 3.5, fill: node.color }));
    penguinIcon(g, x + 31, y + 30, node.color);
    text(g, x + 54, y + 32, node.label, 'node-name');
    text(g, x + 50, y + 55, node.rankLabel.toUpperCase(), 'node-rank');
    g.addEventListener('mouseenter', event => {
        const html = '<strong>' + escapeHtml(node.name) + '</strong><div>Rank: ' + escapeHtml(node.rank) + '</div><div>Visible branch count: ' + node.recruits + '</div>';
        showTooltip(event, html);
    });
    g.addEventListener('mousemove', moveTooltip);
    g.addEventListener('mouseleave', hideTooltip);
    svg.appendChild(g);
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[char]));
}

function showTooltip(event, html) {
    tooltip.innerHTML = html;
    tooltip.classList.add('visible');
    moveTooltip(event);
}

function moveTooltip(event) {
    const padding = 18;
    const rect = tooltip.getBoundingClientRect();
    let x = event.clientX + 16;
    let y = event.clientY + 16;
    if (x + rect.width + padding > window.innerWidth) x = event.clientX - rect.width - 16;
    if (y + rect.height + padding > window.innerHeight) y = event.clientY - rect.height - 16;
    tooltip.style.left = x + 'px';
    tooltip.style.top = y + 'px';
}

function hideTooltip() {
    tooltip.classList.remove('visible');
}

function enableDragScroll() {
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let scrollLeft = 0;
    let scrollTop = 0;
    stage.addEventListener('mousedown', event => {
        dragging = true;
        startX = event.pageX;
        startY = event.pageY;
        scrollLeft = stage.scrollLeft;
        scrollTop = stage.scrollTop;
    });
    window.addEventListener('mouseup', () => { dragging = false; });
    window.addEventListener('mousemove', event => {
        if (!dragging) return;
        stage.scrollLeft = scrollLeft - (event.pageX - startX);
        stage.scrollTop = scrollTop - (event.pageY - startY);
    });
}

renderBackground();
renderLinks();
for (const node of graphData.nodes) {
    if (node.isOverflow) renderOverflow(node);
    else renderPlayer(node);
}
enableDragScroll();
stage.scrollLeft = Math.max(0, graphData.centerX - window.innerWidth / 2);
stage.scrollTop = Math.max(0, graphData.centerY - window.innerHeight / 2);
</script>
</body>
</html>`;
}

module.exports = {
    renderRecruitTreeHtml
};
