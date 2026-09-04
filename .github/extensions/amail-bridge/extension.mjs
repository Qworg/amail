import { joinSession } from "@github/copilot-sdk/extension";

import { loadConfigWithEnvFiles } from "../../../src/config.mjs";
import { createResendClient } from "../../../src/email.mjs";
import { createAmailRuntime } from "../../../src/runtime.mjs";

let runtime;
try {
    const session = await joinSession({
        requestedEnvironmentVariables: ["RESEND_API_KEY"],
    });
    const config = await loadConfigWithEnvFiles();
    const emailClient = createResendClient({ apiKey: config.resendApiKey });
    runtime = createAmailRuntime({ session, config, emailClient });
    await runtime.start();
} catch (error) {
    await runtime?.stop();
    process.stderr.write(`amail failed to start: ${error.message}\n`);
}
