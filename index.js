const MODULE_NAME = 'reddclips';
const TOOL_NAME = 'SendVideoClip';
const DEFAULT_CATEGORY = 'heterosexual';
const MAX_SENT_IDS = 500;

function unescapeUrl(url) {
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
 * Extracts raw CDN endpoints (v.redd.it, redgifs, imgur, etc.) from API payloads
 * or normalizes media URLs into direct MP4 stream links.
 */
function extractDirectMediaUrl(videoObj) {
    // Check if the backend API object already contains direct media attributes
    let url = videoObj.direct_url || videoObj.media_url || videoObj.src || videoObj.url;
    url = unescapeUrl(url);

    if (!url) return '';

    // Convert v.redd.it page/post links to direct video stream endpoints
    if (url.includes('v.redd.it') && !url.endsWith('.mp4') && !url.endsWith('.m3u8')) {
        return `${url.replace(/\/$/, '')}/DASH_720.mp4`;
    }

    // Convert RedGifs watch links to direct CDN video URLs
    if (url.includes('redgifs.com/watch/')) {
        const id = url.split('/watch/')[1]?.split('?')[0];
        if (id) return `https://media.redgifs.com/${id.toLowerCase()}.mp4`;
    }

    // If link is a reddclips webpage route, fallback to original Reddit post target if available
    if (url.includes('reddclips.com/video/') || url.includes('reddclips.com/r/')) {
        if (videoObj.reddit_url) return extractDirectMediaUrl({ url: videoObj.reddit_url });
        if (videoObj.permalink) return `https://v.redd.it/${videoObj.id}/DASH_720.mp4`;
    }

    return url;
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

    const directMediaUrl = extractDirectMediaUrl(video);
    const webPageUrl = unescapeUrl(video.url || `https://reddclips.com/r/${video.subreddit}/${video.id}`);

    const message = {
        name: name,
        is_user: false,
        is_system: false,
        send_date: context.getMessageTimeStamp ? context.getMessageTimeStamp() : Date.now(),
        mes: `[${name} sends a video: "${video.title}" (r/${video.subreddit})]\n\n🔗 [View on Reddclips](${webPageUrl})`,
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
