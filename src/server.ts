import AntrophicAI from '@anthropic-ai/sdk';
import {
  InteractionResponseType,
  InteractionType,
  verifyKey,
} from 'discord-interactions';
import commands from './commands.json';

type Env = {
  DISCORD_PUBLIC_KEY: string; // public key for verifying requests
  DISCORD_APPLICATION_ID: string; // application id for oauth
  ANTHROPIC_API_KEY: string; // anthropic api key
};

const OPUS_MODEL = 'claude-3-opus-20240229';
const HAIKU_MODEL = 'claude-3-haiku-20240307';

const CLAUDE_SYSTEM_PROMPT = ``;

const PLANE_SYSTEM_PROMPT = ``;


export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    if (request.method === 'GET') {
      return new Response(`👋 ${env.DISCORD_APPLICATION_ID}`);
    }
    const { isValid, interaction } = await verifyDiscordRequest(
      request,
      env,
    );
    if (!isValid || !interaction) {
      return new Response('Bad request signature.', { status: 401 });
    }
    if (interaction.type === InteractionType.PING) {
      return Response.json({ type: InteractionResponseType.PONG });
    }
    if (interaction.type === InteractionType.APPLICATION_COMMAND) {
      // Most user commands will come as `APPLICATION_COMMAND`.
      switch (interaction.data.name.toLowerCase()) {
        case commands.CLAUDE_COMMAND.name.toLowerCase(): {
          const message = interaction.data.options[0].value as string;
          ctx.waitUntil(handleDeferredInteractionStreamly(HAIKU_MODEL, CLAUDE_SYSTEM_PROMPT, message, interaction.token, env));
          return Response.json({
            type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
          });
        }
        case commands.CLAUDE_PLANE_COMMAND.name.toLowerCase(): {
          const message = interaction.data.options[0].value as string;
          ctx.waitUntil(handleDeferredInteractionStreamly(OPUS_MODEL, PLANE_SYSTEM_PROMPT, message, interaction.token, env));
          return Response.json({
            type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
          });
        }
        default:
          return Response.json({ error: 'Unknown Type' }, { status: 400 });
      }
    }
    return Response.json({ error: 'Unknown Type' }, { status: 400 });
  },
};

async function handleDeferredInteractionStreamly(
  model: typeof HAIKU_MODEL | typeof OPUS_MODEL,
  system: string,
  message: string,
  token: string,
  env: Env
) {
  const startedAt = Date.now();
  const client = new AntrophicAI({
    apiKey: env.ANTHROPIC_API_KEY,
  });

  const prefixed = message.split('\n').map((line) => `> ${line}`).join('\n');

  const endpoint = `https://discord.com/api/v10/webhooks/${env.DISCORD_APPLICATION_ID}/${token}`;
  await fetch(endpoint, {
    method: "POST",
    body: JSON.stringify({
      content: `${prefixed}\n\n(考え中)`,
    }),
    headers: {
      "Content-Type": "application/json",
    }
  });

  const patch_endpoint = `https://discord.com/api/v10/webhooks/${env.DISCORD_APPLICATION_ID}/${token}/messages/@original`;

  let current = '';
  const stream = client.messages.stream({
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: message }
        ]
      },
    ],
    model: model,
    max_tokens: 400,
    system,
  }).on('text', (text) => {
    current += text;
  });

  const update = async (content: string) => {
    await fetch(patch_endpoint, {
      method: "PATCH",
      body: JSON.stringify({
        content: content,
      }),
      headers: {
        "Content-Type": "application/json",
      }
    });
  }

  const intervalId = setInterval(async () => {
    update(`${prefixed}\n\n${current}\n(考え中)`);
  }, 5000);

  let ended = false;
  await Promise.allSettled([
    stream.finalMessage().then(async (res) => {
      ended = true;
      clearInterval(intervalId);
      await update(`${prefixed}\n\n${res.content[0].text}`);
    }),
    new Promise<void>((resolve) => setTimeout(async () => {
      if (ended) return;
      stream.abort();
      clearInterval(intervalId);
      await update(`${prefixed}\n\n${current}\n[timeout:${Date.now() - startedAt}ms]`);
      resolve();
    }, 27000)),
  ]);
}

async function verifyDiscordRequest(request: Request, env: Env) {
  const signature = request.headers.get('x-signature-ed25519');
  const timestamp = request.headers.get('x-signature-timestamp');
  const body = await request.text();
  const isValidRequest =
    signature &&
    timestamp &&
    verifyKey(body, signature, timestamp, env.DISCORD_PUBLIC_KEY);
  if (!isValidRequest) {
    return { isValid: false };
  }
  return { interaction: JSON.parse(body), isValid: true };
}

