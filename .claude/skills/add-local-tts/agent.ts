/**
 * Local TTS - MCP Tool Definitions (Container / Agent Side)
 *
 * Exposes a single tool `reply_with_audio` that the container agent calls
 * ONLY when the user explicitly asks for an audio reply (e.g. "me responda
 * por áudio", "resuma isso em um áudio"). The tool writes an IPC request
 * that the host picks up; the host synthesizes the audio with `say` + ffmpeg
 * and sends it as a WhatsApp voice note.
 *
 * This file is compiled inside the container, not on the host.
 */

// @ts-ignore - SDK available in container environment only
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';

const IPC_DIR = '/workspace/ipc';
const TASKS_DIR = path.join(IPC_DIR, 'tasks');
const RESULTS_DIR = path.join(IPC_DIR, 'tts_results');

function writeIpcFile(dir: string, data: object): void {
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);
}

async function waitForResult(
  requestId: string,
  maxWait = 90_000,
): Promise<{ success: boolean; message: string }> {
  const resultFile = path.join(RESULTS_DIR, `${requestId}.json`);
  const pollInterval = 1000;
  let elapsed = 0;
  while (elapsed < maxWait) {
    if (fs.existsSync(resultFile)) {
      try {
        const result = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
        fs.unlinkSync(resultFile);
        return result;
      } catch (err) {
        return { success: false, message: `failed to read result: ${err}` };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
    elapsed += pollInterval;
  }
  return { success: false, message: 'tts request timed out' };
}

export interface SkillToolsContext {
  groupFolder: string;
  isMain: boolean;
}

export function createTtsTools(ctx: SkillToolsContext) {
  const { groupFolder } = ctx;

  return [
    tool(
      'reply_with_audio',
      `Send a voice-note reply to the current chat via local text-to-speech.

USE THIS TOOL ONLY when the user EXPLICITLY asks for an audio response, for example:
- "me responda por áudio ..."
- "resuma isso em um áudio"
- "responde em áudio"
- "answer me with a voice note"

Do NOT use it proactively or when only the topic is audio-related. If the user did
not explicitly request audio, just reply with text as normal.

The host synthesizes the provided \`text\` via the macOS \`say\` command, re-encodes
it to OGG/Opus, and sends it as a WhatsApp voice note (push-to-talk) to the current
chat. Keep the text concise — this is spoken aloud, so write for the ear, not the eye.
Avoid Markdown, code blocks, URLs, and emojis; spell out numbers and abbreviations
when it helps. Aim for under ~600 characters per audio unless the user asked for
something longer.`,
      {
        text: z
          .string()
          .min(1)
          .max(4000)
          .describe(
            'Plain text to speak aloud. No Markdown, URLs, or code. Write as if narrating.',
          ),
        voice: z
          .string()
          .optional()
          .describe(
            'Optional voice override (e.g. "Luciana", "Samantha"). Defaults to TTS_VOICE / TTS_LANGUAGE on the host.',
          ),
        rate: z
          .string()
          .optional()
          .describe(
            'Optional speaking rate in words/minute, e.g. "180". Defaults to TTS_RATE.',
          ),
      },
      async (args: { text: string; voice?: string; rate?: string }) => {
        const requestId = `tts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        writeIpcFile(TASKS_DIR, {
          type: 'tts_reply',
          requestId,
          groupFolder,
          text: args.text,
          voice: args.voice,
          rate: args.rate,
          timestamp: new Date().toISOString(),
        });

        const result = await waitForResult(requestId);
        return {
          content: [
            {
              type: 'text',
              text: result.success
                ? `Voice note sent. ${result.message}`
                : `Audio reply failed: ${result.message}`,
            },
          ],
          isError: !result.success,
        };
      },
    ),
  ];
}
