const MODULE_NAME = 'reddclips';
const TOOL_NAME = 'SendVideoClip';
const DEFAULT_CATEGORY = 'heterosexual';
const MAX_SENT_IDS = 500;

function cleanUrl(url) {
    if (typeof url !== 'string') return url;
    return url.replace(/\\ me/g, '').replace(/\\\//g, '/').trim();
}

function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    if (typeof extensionSettings[MODULE_NAME] !== 'object' || extensionSettings[MODULE_NAME] === null) {
        extensionSettings[MODULE_NAME] = { sent: {} };
    }
    if (typeof extensionSettings[MODULE_NAME].sent !== 'object' || extensionSettings[MODULE_NAME].sent === null) {
        extensionSettings[MODULE_NAME].sent = {};
    }
    return extensionSettings[MODULE_NAME];
}

/**
 * Converts synthetic Reddclips page links into real playable stream URLs
 */
function resolveRealMediaUrl(video) {
    let rawUrl = cleanUrl(video.url);

    // If API sends a reddclips.com/video/[id].mp4 link, extract ID & stream from Reddit direct CDN
    if (rawUrl.includes('reddclips.com/video/')) {
        const matches = rawUrl.match(/\/video\/([a-zA-Z0-9]+)\.mp4/);
        const videoId = matches ? matches[1] : video.id;
        if (videoId) {
            return `https://v.redd.it/${videoId}/DASH_720.mp4`;
        }
    }

    // Fallback to video.id if rawUrl is a webpage
    if (video.id && !rawUrl.match(/\.(mp4|webm)(\?.*)?$/i)) {
        return `https://v.redd.it/${video.id}/DASH_720.mp4`;
    }

    // Convert raw v.redd.it base links to direct MP4 DASH streams
    if (rawUrl.includes('v.redd.it') && !rawUrl.endsWith('.mp4') && !rawUrl.endsWith('.m3u8')) {
        return `${rawUrl.replace(/\/$/, '')}/DASH_720.mp4`;
    }

    return rawUrl;
}

async function fetchVideos(category) {
    const response = await fetch(`/api/reddclips/videos?category=${encodeURIComponent(category)}`, {
        headers: SillyTavern.getContext().getRequestHeaders(),
    });
    if (!response.ok) throw new Error('Could not reach Reddclips right now. Try again in a bit.');
    
    const data = await response.json();
    if (!Array.isArray(data?.videos) || data.videos.length === 0) {
        throw new Error('No videos available right now.');
    }

    return data.videos;
}

function pickUnseenVideo(videos, seenIds) {
    const fresh = videos.filter(video => !seenIds.has(video.id));
    if (fresh.length > 0) return { video: fresh[Math.floor(Math.random() * fresh.length)], cycled: false };
    return { video: videos[Math.floor(Math.random() * videos.length)], cycled: true };
}

async function sendVideoMessage(video) {
    const context = SillyTavern.getContext();
    const name = context.groupId ? context.name1 : context.name2;

    const directMediaUrl = resolveRealMediaUrl(video);
    const webPageUrl = cleanUrl(video.url);

    const message = {
        name: name,
        is_user: false,
        is_system: false,
        send_date: context.getMessageTimeStamp ? context.getMessageTimeStamp() : Date.now(),
        mes: `[${name} sends a video: "${video.title}" (r/${video.subreddit})]\n\n🔗 [Watch Page](${webPageUrl})`,
        extra: {
            media: [{ 
                url: directMediaUrl, 
                type: 'video', 
                title: video.title, 
                source: 'api' 
            }],
            media_display: 'gallery',
            media_index: 0,
            inline_image: false,
        },
    };

    context.chat.push(message);
    context.addOneMessage(message);
    await context.saveChat();
}

export async function init() {
    const { registerFunctionTool, getCurrentChatId, saveSettingsDebounced } = SillyTavern.getContext();
    
    registerFunctionTool({
        name: TOOL_NAME,
        displayName: 'Send Video Clip',
        description: 'Fetch a random video clip from Reddclips and send it in the chat.',
        parameters: Object.freeze({
            $schema: 'http://json-schema.org/draft-04/schema#',
            type: 'object',
            properties: { 
                category: { 
                    type: 'string', 
                    description: `Reddclips category slug (for example "${DEFAULT_CATEGORY}"). Defaults to "${DEFAULT_CATEGORY}".` 
                } 
            },
            required: [],
        }),
        action: async (args) => {
            const category = String(args?.category || DEFAULT_CATEGORY).trim().toLowerCase() || DEFAULT_CATEGORY;
            const videos = await fetchVideos(category);
            const settings = getSettings();
            const chatId = getCurrentChatId();
            
            if (!Array.isArray(settings.sent[chatId])) settings.sent[chatId] = [];
            const seenIds = new Set(settings.sent[chatId]);
            const { video, cycled } = pickUnseenVideo(videos, seenIds);

            seenIds.add(video.id);
            settings.sent[chatId] = [...seenIds].slice(-MAX_SENT_IDS);
            saveSettingsDebounced();

            await sendVideoMessage(video);
            return `Sent video "${video.title}" (r/${video.subreddit})${cycled ? ' (cycle restarted)' : ''}`;
        },
    });
}
