# amail

`amail` is an email control surface for a standard interactive GitHub Copilot
CLI session. While away mode is enabled, its project extension:

- mirrors native Copilot questions to email and applies the first valid reply;
- emails the final assistant response when the root turn becomes idle;
- accepts one reply to that completion email as the next prompt in the same
  still-idle session.

The terminal remains active and authoritative. Permission prompts are never
approved through email, and all routing state is intentionally in memory.

## Requirements

- Node.js 20 or newer
- GitHub Copilot CLI `1.0.83-3`
- A Resend API key with both send and received-email access
- A verified Resend sender and receiving domain

## Setup

Copy `.env.example` to `.env`, or put the same variables in `..\.env`. Process
environment variables override both files.

```dotenv
RESEND_API_KEY=re_replace_me
AMAIL_TO=you@example.com
AMAIL_FROM=amail@your-verified-domain.example
AMAIL_RECEIVE_DOMAIN=your-receiving-domain.example
AMAIL_POLL_INTERVAL_MS=30000
```

Install the local CLI command, start Copilot from this repository, and enable
away mode before stepping away:

```powershell
npm install
npm link
amail away on
copilot
```

Use `amail away status` to inspect the marker and `amail away off` when you
return. The extension is loaded from `.github\extensions\amail-bridge`.

For a Resend test account, representative values are:

```dotenv
AMAIL_TO=jeffkramer@microsoft.com
AMAIL_FROM=amail@your-verified-sending-domain.example
AMAIL_RECEIVE_DOMAIN=yuunee.resend.app
```

Do not commit the API key. Received replies must come from `AMAIL_TO`; tokens
expire after 15 minutes, are single-use, and are scoped to one question or one
idle-session follow-up. Resend receiving domains are not automatically valid
sending domains; `AMAIL_FROM` must use a separately verified sending domain.

## Development

```powershell
npm test
npm run check
npm run verify:probe
npm run test:mutation
```

The unit suite names the three core scenarios directly: email question
resolution and terminal-first invalidation, completion-to-follow-up injection,
and stale-session rejection. It uses
`test\fixtures\resend-received-email.json` when live inbound mail is delayed.

`npm run verify:probe` validates the committed, sanitized native request-race
recording in `test\fixtures\amail-milestone-1-events.jsonl`: the TUI remained
active, extension-first resolution succeeded, and terminal-first resolution
made the extension lose safely.

The native Copilot race probe, Resend received-email API, and outbound delivery
to the configured Microsoft address were exercised live. A live structured
question was delivered and its response returned to the native Copilot
elicitation. The remaining routing cases are covered with the real event/RPC
shapes and a fixture-backed Resend client.
