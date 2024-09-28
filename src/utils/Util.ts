import {
    AttachmentBuilder, codeBlock, Message, User,
} from 'discord.js';
import type { Client } from 'discordx';
import type { TextContentBlock } from 'openai/resources/beta/threads';
import '@colors/colors';
import OpenAI from 'openai';
import Keyv from 'keyv';
import KeyvSqlite from '@keyv/sqlite';
import moment from 'moment';

interface UserData {
    totalQueries: number;
    queriesRemaining: number;
    expiration: number;
    whitelisted: boolean;
    blacklisted: boolean;
    threadId: string;
}

interface EntryValue {
    userId?: string;
    totalQueries: number;
}

const keyv = new Keyv({ store: new KeyvSqlite({ uri: 'sqlite://src/data/db.sqlite' }), namespace: 'userData' });
keyv.on('error', (err) => console.log('[keyv] Connection Error', err));

/**
 * Capitalises the first letter of each word in a string.
 * @param string - The string to be capitalised.
 * @returns The capitalised string.
 */
export function capitalise(string: string): string {
    return string.split(' ')
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

/**
 * Checks if a message is deletable, and deletes it after a specified amount of time.
 * @param message - The message to check.
 * @param delay - The amount of time to wait before deleting the message, in milliseconds.
 * @returns void
 */
export function messageDelete(message: Message, delay: number): void {
    setTimeout(async () => {
        try {
            if (message && message.deletable) {
                await message.delete();
            }
        } catch (error) {
            // Handle the error gracefully, log it, or perform any necessary actions
            console.error('Error deleting message:', error);
        }
    }, delay);
}

/**
 * Fetches the registered global application commands and returns an object
 * containing the command names as keys and their corresponding IDs as values.
 * @param client - The Discord Client instance.
 * @returns An object containing command names and their corresponding IDs.
 * If there are no commands or an error occurs, an empty object is returned.
 */
export async function getCommandIds(client: Client): Promise<{ [name: string]: string }> {
    try {
        // Fetch the registered global application commands
        const commands = await client.application?.commands.fetch();

        if (!commands) {
            return {};
        }

        // Create an object to store the command IDs
        return Object.fromEntries(
            commands.map((command) => [command.name, command.id]),
        );
    } catch (error) {
        console.error('Error fetching global commands:', error);
        return {};
    }
}

/**
 * Load Assistant function to query the OpenAI API for a response.
 * @param query - The user query to be sent to the Assistant.
 * @param user - The User for the target.
 * @returns The response text from the Assistant.
 */
export async function loadAssistant(
    query: string,
    user: User,
): Promise<string | string[] | Error | boolean> {
    // Retrieve user's GPT query data from the database.
    const userQueryData = await getGptQueryData(user.id);

    const str = query.replaceAll(/<@!?(\d+)>/g, '');

    if (str.length < 4) {
        return 'Please enter a valid query, with a minimum length of 4 characters.';
    }

    try {
        const openai = new OpenAI({
            apiKey: process.env.OpenAiKey,
        });

        // Retrieve the Assistant information
        const assistant = await openai.beta.assistants.retrieve(`${process.env.AssistantId}`);

        // Fetch or create thread.
        let thread: OpenAI.Beta.Threads.Thread;
        try {
            thread = userQueryData && userQueryData.threadId
                ? await openai.beta.threads.retrieve(userQueryData.threadId)
                : await openai.beta.threads.create();
        } catch {
            thread = await openai.beta.threads.create();
        }

        const {
            totalQueries, queriesRemaining,
            expiration, whitelisted, blacklisted, threadId,
        } = userQueryData || {};

        if (threadId !== thread.id) {
            await setGptQueryData(
                user.id,
                Number(totalQueries) || 0,
                Number(queriesRemaining) || 0,
                Number(expiration) || 0,
                whitelisted || false,
                blacklisted || false,
                thread.id,
            );
        }

        // This section check if the user has an existing run.
        let existingRun;

        try {
            const response = await openai.beta.threads.runs.list(thread.id);
            existingRun = ['queued', 'in_progress'].includes(response?.data?.[0]?.status) || false;
        } catch {
            existingRun = false;
        }

        if (existingRun) return true;

        // Add a user message to the thread
        await openai.beta.threads.messages.create(thread.id, {
            role: 'user',
            content: str,
        });

        // Create a run with the Assistant
        const createRun = await openai.beta.threads.runs.create(thread.id, {
            assistant_id: assistant.id,
        });

        let retrieve = await openai.beta.threads.runs.retrieve(thread.id, createRun.id);

        // Define a sleep function
        const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => {
            setTimeout(resolve, ms);
        });

        console.log(
            `${'◆◆◆◆◆◆'.rainbow.bold} ${moment().format('MMM D, h:mm A')} ${reversedRainbow('◆◆◆◆◆◆')}\n`
            + `${'🚀 Query initiated by '.brightBlue.bold}${user.displayName.underline.brightMagenta.bold}\n`
            + `${'📝 Query: '.brightBlue.bold}${str.brightYellow.bold}`,
        );

        /**
         * Check the completion status of the query run.
         */
        async function checkCompletion() {
            if (retrieve.status !== 'completed' && retrieve.status !== 'in_progress' && retrieve.status !== 'queued') {
                // Optional last error message if it exists
                const lastError = retrieve.last_error ? `\nError Code: ${retrieve.last_error.code}` : '';

                // Throw an error message
                throw new Error(`completion\nStatus: ${retrieve.status}${lastError}`);
            }

            console.log(retrieve.status === 'completed'
                ? `${'✅ Status: '.brightBlue.bold}${retrieve.status.brightGreen.bold}`
                : `${'🔄 Status: '.brightBlue.bold}${retrieve.status.brightYellow.bold}`);

            if (retrieve.status !== 'completed') {
                await sleep(2000);
                retrieve = await openai.beta.threads.runs.retrieve(thread.id, createRun.id);
                await checkCompletion();
            }
        }

        await checkCompletion();

        // Get the list of messages in the thread
        const messages = await openai.beta.threads.messages.list(thread.id);

        console.log(`${'🎉 Completed query for '.brightBlue.bold}${user.displayName.underline.brightMagenta.bold}\n`);

        // Extract text value from the Assistant's response
        const textValue = (messages.data[0].content[0] as TextContentBlock)?.text?.value;

        // Process string
        const responseText = await processString(textValue);

        // If the length of the text is greater than the desired target and does not exceed a desired target
        // then proceed to split the response into an array of messages
        if (responseText.length >= 1950) {
            return await splitMessages(responseText, 1950);
        }

        // Length does not exceed the desired target, return string
        return responseText;
    } catch (error) {
        console.error(error);
        return error as Error;
    }
}

/**
 * Generates text-to-speech audio from a given string for a user.
 * @param str - The text to convert to speech.
 * @param user - The user requesting the text-to-speech conversion.
 * @returns A Promise that resolves to an AttachmentBuilder with the audio,
 *          a string error message if the user has no available queries,
 *          or an Error if the TTS generation fails.
 */
export async function runTTS(str: string, user: User): Promise<AttachmentBuilder | string | Error> {
    // Check if the user has available queries
    const availabilityCheck = await checkGptAvailability(user.id);
    if (typeof availabilityCheck === 'string') return availabilityCheck;

    try {
        // Log the start of the TTS process with colorful formatting
        console.log(`${'◆◆◆◆◆◆'.rainbow.bold} ${moment().format('MMM D, h:mm A')} ${reversedRainbow('◆◆◆◆◆◆')}\n`
            + `${'🚀 Text-to-Speech initiated by '.brightBlue.bold}${user.displayName.underline.brightMagenta.bold}`);

        // Initialize OpenAI client
        const openai = new OpenAI({ apiKey: process.env.OpenAiKey });

        // Generate TTS using OpenAI's API
        const tts = await openai.audio.speech.create({
            model: 'tts-1',
            voice: 'echo',
            input: str,
        });

        // Log completion of TTS generation
        console.log(`${'🎉 Completed text-to-speech for '.brightBlue.bold}${user.displayName.underline.brightMagenta.bold}`);

        // Convert the audio to a Discord-compatible attachment
        return new AttachmentBuilder(Buffer.from(await tts.arrayBuffer()), { name: 'tts.mp3' });
    } catch (error) {
        console.error(error);
        return error as Error;
    }
}

/**
 * Sets GPT query data for a specific user.
 * @param userId - The ID of the user.
 * @param totalQueries - Total number of queries made by the user.
 * @param queriesRemaining - Number of queries remaining for the user.
 * @param expiration - Timestamp for when the user's query allowance expires.
 * @param whitelisted - Whether the user is whitelisted.
 * @param blacklisted - Whether the user is blacklisted.
 * @param threadId - The thread ID associated with the user's conversation.
 * @returns A promise that resolves with the newly set user data.
 */
export async function setGptQueryData(
    userId: string,
    totalQueries: number,
    queriesRemaining: number,
    expiration: number,
    whitelisted: boolean,
    blacklisted: boolean,
    threadId: string,
): Promise<UserData> {
    // Create a UserData object with the provided parameters
    const data: UserData = {
        totalQueries,
        queriesRemaining,
        expiration,
        whitelisted,
        blacklisted,
        threadId,
    };

    // Store the user data in the key-value store
    await keyv.set(userId, data);

    // Return the stored data
    return data;
}

/**
 * Retrieves GPT query data for a specific user.
 * @param userId - The unique identifier of the user.
 * @returns The user's query data, or false if no data is found.
 */
export async function getGptQueryData(userId: string): Promise<UserData | false> {
    const data = await keyv.get(userId) as UserData | null;
    return data || false;
}

/**
 * Checks GPT availability for a specific user and manages query limits.
 * @param userId - The ID of the user.
 * @returns A string indicating the reset time or a boolean for query availability.
 */
export async function checkGptAvailability(userId: string): Promise<string | boolean> {
    // Parse the rate limit from environment variables
    const RateLimit = Number(process.env.RateLimit);

    // Retrieve user's GPT query data from the database
    const userQueryData = await getGptQueryData(userId);

    // Calculate current time and expiration time (24 hours from now)
    const currentTime = new Date();
    const expirationTime = new Date(currentTime.getTime() + 24 * 60 * 60 * 1000);

    // If the user has no existing data, create a new entry
    if (!userQueryData) {
        await setGptQueryData(
            userId,
            1,
            RateLimit - 1,
            expirationTime.getTime(),
            false,
            false,
            '',
        );
        return true; // User can make a query
    }

    // If the user is blacklisted, deny access
    if (userQueryData.blacklisted) {
        return 'You are currently blacklisted. If you believe this is a mistake, please contact a moderator.';
    }

    // If the user is whitelisted, allow query and reset their limit
    if (userQueryData.whitelisted) {
        await setGptQueryData(
            userId,
            userQueryData.totalQueries + 1,
            RateLimit,
            1,
            userQueryData.whitelisted,
            userQueryData.blacklisted,
            userQueryData.threadId,
        );
        return true;
    }

    // Check if the user has exhausted their query limit
    if (userQueryData.queriesRemaining <= 0) {
        const expiration = new Date(userQueryData.expiration);

        // If 24 hours have passed since the last query, reset the user's limit
        if (currentTime > expiration) {
            await setGptQueryData(
                userId,
                userQueryData.totalQueries + 1,
                RateLimit,
                expirationTime.getTime(),
                userQueryData.whitelisted,
                userQueryData.blacklisted,
                userQueryData.threadId,
            );
            return true;
        }

        // If the query limit is still active, return a message with the reset time
        return `It looks like you've reached your query limit for now. Don't worry, your queries will reset <t:${Math.floor(expiration.getTime() / 1000)}:R>`;
    }

    // User has queries remaining, update their data
    await setGptQueryData(
        userId,
        userQueryData.totalQueries + 1,
        userQueryData.queriesRemaining - 1,
        userQueryData.expiration === 1 ? expirationTime.getTime() : userQueryData.expiration,
        userQueryData.whitelisted,
        userQueryData.blacklisted,
        userQueryData.threadId,
    );
    return true;
}

/**
 * Runs the GPT assistant for the specified user and content.
 * @param content - The content for the GPT assistant.
 * @param user - The User object for the target.
 * @returns A promise that resolves to a string, array of strings, or boolean.
 * @throws An error if there's an issue with the GPT assistant or user queries.
 */
export async function runGPT(content: string, user: User): Promise<string | string[] | boolean> {
    // Check if the user has available queries
    const isGptAvailable = await checkGptAvailability(user.id);
    if (typeof isGptAvailable === 'string') return isGptAvailable;

    // Load the Assistant for the message content
    const response = await loadAssistant(content.trim(), user);

    // Handle different response types
    if (typeof response === 'boolean' || typeof response === 'string' || Array.isArray(response)) {
        return response;
    }

    // If the response is neither boolean, string, nor array, it's considered an error
    return `An error occurred, please report this to a member of our moderation team.\n${codeBlock('ts', `${response}`)}`;
}

/**
 * Splits a given content string into chunks of a specified size, ensuring words are not cut.
 * Each chunk is appended with a page number and the total number of chunks.
 * @param content - The input string to be split.
 * @param length - The desired length of each chunk.
 * @returns An array of strings representing the split content.
 */
export function splitMessages(content: string, length: number): string[] {
    const chunks: string[] = [];
    let remainingContent = content.trim();

    while (remainingContent.length > 0) {
        const chunkEnd = remainingContent.length <= length
            ? remainingContent.length
            : remainingContent.lastIndexOf(' ', length) || remainingContent.indexOf(' ', length);

        chunks.push(remainingContent.slice(0, chunkEnd).trim());
        remainingContent = remainingContent.slice(chunkEnd).trim();
    }

    const totalChunks = chunks.length;
    return chunks.map((chunk, index) => `${chunk}\n\`${index + 1}\`/\`${totalChunks}\``);
}

/**
 * Processes a string by removing specific brackets and formatting links based on environment variables.
 * @param str - The input string to process.
 * @returns The processed string.
 */
export function processString(str: string): string {
    const embedLinks = process.env.EmbedLinks !== 'false';

    return str.replace(/【.*?】/g, '')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => (text === url
            ? embedLinks ? url : `<${url}>`
            : embedLinks ? `[${text}](${url})` : `[${text}](<${url}>)`));
}

/**
 * Iterates through entries from a key-value store, calculates the total queries sum,
 * and returns the top 10 entries sorted by the number of queries in descending order.
 *
 * @returns A Promise that resolves to an object containing the total queries sum and
 *          an array of the top 10 entries, or an Error if something goes wrong.
 */
export async function fetchAllData(): Promise<{ totalQueriesSum: number; top10Entries: EntryValue[] } | Error> {
    const entries: EntryValue[] = [];
    let totalQueriesSum = 0;

    try {
        // @ts-expect-error temp
        for await (const [key, { totalQueries }] of keyv.iterator()) {
            entries.push({ totalQueries, userId: key });
            totalQueriesSum += totalQueries;
        }

        // Return the results: total queries sum and top 10 sorted entries
        return {
            totalQueriesSum,
            top10Entries: entries
                .sort((a, b) => b.totalQueries - a.totalQueries)
                .slice(0, 10),
        };
    } catch (error) {
        return error as Error;
    }
}

/**
 * Applies a reversed rainbow effect to the input string.
 * @param str - The string to apply the reversed rainbow effect.
 * @returns The input string with reversed rainbow coloring.
 */
export const reversedRainbow = (str: string): string => {
    const colors = ['red', 'magenta', 'blue', 'green', 'yellow', 'red'] as const;
    return str
        .split('')
        .map((char, i) => char[colors[i % colors.length] as keyof typeof char])
        .join('');
};
