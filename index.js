const MODULE_NAME = 'reddclips';
const TOOL_NAME = 'SendVideoClip';
const DEFAULT_CATEGORY = 'heterosexual';
const MAX_SENT_IDS = 500;

function unescapeUrl(url) {
    if (typeof url !== 'string') return url;
    return url.replace(/\\ me/g, '').replace(/\\\//g, '/');
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
 * Resolves HTML webpage links (e.g., https://reddclips.com/r/...) 
 * into direct playable MP4 / media stream URLs.
 */
async function resolveDirectMediaUrl(pageUrl) {
    if (typeof pageUrl !== 'string' || !pageUrl) return pageUrl;

    // Direct video stream already
    if (pageUrl.match(/\.(mp4|webm|m3u8)(\?.*)?$/i)) {
        return pageUrl;
    }

    // Handle v.redd.it direct fallback
    if (pageUrl.includes('v.redd.it')) {
        return `${pageUrl.replace(/\/$/, '')}/DASH_720.mp4`;
    }

    try {
        const response = await fetch(pageUrl);
        if (!response.ok) return pageUrl;
        
        const html = await response.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');

        // Extract direct video source from OpenGraph tags or video elements
        const directMedia = doc.querySelector('meta[property="og:video:secure_url"]')?.getAttribute('content') ||
                            doc.querySelector('meta[property="og:video"]')?.getAttribute('content') ||
                            doc.querySelector('video source')?.getAttribute('src') ||
                            doc.querySelector('video')?.getAttribute('src');

        return directMedia ? unescapeUrl(directMedia) : pageUrl;
    } catch (e) {
        console.warn('[Reddclips] Failed to resolve direct media URL:', e);
        return pageUrl;
    }
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

    return data.videos.map(video => ({
        ...video,
        url: unescapeUrl(video.url)
    }));
}

function pickUnseenVideo(videos, seenIds) {
    const fresh = videos.filter(video => !seenIds.has(video.id));
    if (fresh.length > 0) return { video: fresh[Math.floor(Math.random() * fresh.length)], cycled: false };
    return { video: videos[Math.floor(Math.random() * videos.length)], cycled: true };
}

async function sendVideoMessage(video) {
    const context = SillyTavern.getContext();
    const name = context.groupId ? context.name1 : context.name2;

    // Resolve direct streaming video file URL from webpage link
    const directVideoUrl = await resolveDirectMediaUrl(video.url);

    const message = {
        name: name,
        is_user: false,
        is_system: false,
        send_date: context.getMessageTimeStamp ? context.getMessageTimeStamp() : Date.now(),
        mes: `[${name} sends a video: "${video.title}" (r/${video.subreddit})]\n\n${directVideoUrl}`,
        extra: {
            media: [{ url: directVideoUrl, type: 'video', title: video.title, source: 'api' }],
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
        description: 'Fetch a random video clip from Reddclips and send it in the chat. Use when the user asks for a video, a clip, or something to watch. Every call sends a different video not sent before in this chat.',
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
            return `Sent video "${video.title}" (r/${video.subreddit}): ${video.url}${cycled ? ' (cycle restarted)' : ''}`;
        },
    });
}
