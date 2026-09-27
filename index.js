import { eventSource, event_types, getCurrentChatId, getRequestHeaders, saveSettingsDebounced, systemUserName } from '../../../script.js';
import { debounce_timeout, MEDIA_DISPLAY, MEDIA_SOURCE, MEDIA_TYPE } from '../../constants.js';
import { extension_settings, getContext } from '../../extensions.js';
import { getMessageTimeStamp } from '../../RossAscends-mods.js';
import { ToolManager } from '../../tool-calling.js';

const MODULE_NAME = 'reddclips';
const TOOL_NAME = 'SendVideoClip';
const DEFAULT_CATEGORY = 'heterosexual';
// Cap the per-chat history so settings.json stays small.
const MAX_SENT_IDS = 500;

function getSettings() {
    if (typeof extension_settings[MODULE_NAME] !== 'object' || extension_settings[MODULE_NAME] === null) {
        extension_settings[MODULE_NAME] = { sent: {} };
    }
    if (typeof extension_settings[MODULE_NAME].sent !== 'object' || extension_settings[MODULE_NAME].sent === null) {
        extension_settings[MODULE_NAME].sent = {};
    }
    return extension_settings[MODULE_NAME];
}

/**
 * Some upstream responses double-escape URLs (e.g. the server JSON-encodes
 * the payload twice), leaving literal backslashes before slashes such as
 * "https:\\/\\/reddclips.com\\/video\\/abc.mp4". A URL like that fails to
 * resolve in the browser, so the <video> element never loads any media and
 * appears "stuck" at 00:00. This strips any number of escaping passes.
 */
function unescapeUrl(url) {
    if (typeof url !== 'string') {
        return url;
    }
    let previous;
    let cleaned = url;
    do {
        previous = cleaned;
        cleaned = cleaned.replace(/\\\//g, '/');
    } while (cleaned !== previous);
    return cleaned;
}

async function fetchVideos(category) {
    const response = await fetch(`/api/reddclips/videos?category=${encodeURIComponent(category)}`, {
        headers: getRequestHeaders(),
    });
    if (!response.ok) {
        throw new Error('Could not reach Reddclips right now. Try again in a bit.');
    }
    const data = await response.json();
    if (!Array.isArray(data?.videos) || data.videos.length === 0) {
        throw new Error('No videos available right now.');
    }
    return data.videos.map(video => ({ ...video, url: unescapeUrl(video.url) }));
}

/**
 * Picks a random video the current chat has not seen yet.
 * When the whole feed was already sent, starts a fresh cycle instead of failing.
 */
function pickUnseenVideo(videos, seenIds) {
    const fresh = videos.filter(video => !seenIds.has(video.id));
    if (fresh.length > 0) {
        return { video: fresh[Math.floor(Math.random() * fresh.length)], cycled: false };
    }
    return { video: videos[Math.floor(Math.random() * videos.length)], cycled: true };
}

async function sendVideoMessage(video) {
    const context = getContext();
    const name = context.groupId ? systemUserName : context.name2;
    const messageText = `[${name} sends a video: "${video.title}" (r/${video.subreddit})]`;
    /** @type {MediaAttachment} */
    const mediaAttachment = {
        url: video.url,
        type: MEDIA_TYPE.VIDEO,
        title: video.title,
        source: MEDIA_SOURCE.API,
    };
    /** @type {ChatMessage} */
    const message = {
        name: name,
        is_user: false,
        is_system: false,
        send_date: getMessageTimeStamp(),
        mes: messageText,
        extra: {
            media: [mediaAttachment],
            media_display: MEDIA_DISPLAY.GALLERY,
            media_index: 0,
            inline_image: false,
        },
    };
    context.chat.push(message);
    const messageId = context.chat.length - 1;
    await eventSource.emit(event_types.MESSAGE_RECEIVED, messageId, 'extension');
    context.addOneMessage(message);
    await eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, messageId, 'extension');
    await context.saveChat();
    setTimeout(() => context.scrollOnMediaLoad(), debounce_timeout.short);
}

function registerTool() {
    ToolManager.registerFunctionTool({
        name: TOOL_NAME,
        displayName: 'Send Video Clip',
        description: [
            'Fetch a random video clip from Reddclips and send it in the chat.',
            'Use when the user asks for a video, a clip, or something to watch.',
            'Every call sends a different video that has not been sent before in this chat.',
            'The video streams from its source URL and is never downloaded or saved.',
        ].join(' '),
        parameters: Object.freeze({
            $schema: 'http://json-schema.org/draft-04/schema#',
            type: 'object',
            properties: {
                category: {
                    type: 'string',
                    description: `Reddclips category slug (for example "${DEFAULT_CATEGORY}"). Defaults to "${DEFAULT_CATEGORY}".`,
                },
            },
            required: [],
        }),
        action: async (args) => {
            const category = String(args?.category || DEFAULT_CATEGORY).trim().toLowerCase() || DEFAULT_CATEGORY;
            const videos = await fetchVideos(category);
            const settings = getSettings();
            const chatId = getCurrentChatId();
            if (!Array.isArray(settings.sent[chatId])) {
                settings.sent[chatId] = [];
            }
            const seenIds = new Set(settings.sent[chatId]);
            const { video, cycled } = pickUnseenVideo(videos, seenIds);
            seenIds.add(video.id);
            settings.sent[chatId] = [...seenIds].slice(-MAX_SENT_IDS);
            saveSettingsDebounced();
            await sendVideoMessage(video);
            return `Sent video "${video.title}" (r/${video.subreddit}): ${video.url}${cycled ? ' (Every fresh clip was already sent, so a new cycle started.)' : ''}`;
        },
    });
}

export async function init() {
    registerTool();
}
