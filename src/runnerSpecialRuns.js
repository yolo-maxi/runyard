import { reauthEnabled, runReauth } from "./reauthCli.js";
import { supportWarmEnabled, warmSupportReply } from "./supportWarm.js";

export async function handleRunnerSpecialRun({
  capability,
  run,
  secretEnv = {},
  runnerName,
  runnerId,
  client,
  event,
  failRun,
  log = console.log,
  isReauthEnabled = reauthEnabled,
  runReauthFn = runReauth,
  isSupportWarmEnabled = supportWarmEnabled,
  warmSupportReplyFn = warmSupportReply
}) {
  if (isReauthEnabled() && capability.slug === "reauth-cli") {
    await event(run.id, "runner.reauth", `Starting CLI re-auth on ${runnerName}`, { runnerId, provider: run.input?.provider });
    const reauth = await runReauthFn(run.input || {}, {
      secretEnv,
      onVerification: (info) =>
        client
          .post(`/api/runs/${run.id}/events`, {
            type: "reauth.verification",
            message: `Open ${info.verificationUrl} and enter code ${info.userCode}`,
            data: { reauth: info }
          })
          .catch(() => {})
    });
    if (reauth.status === "ok") {
      await client.post(`/api/runs/${run.id}/complete`, { output: { outputs: { reauth } } });
      log(`Completed ${run.id} via reauth (${reauth.provider})`);
    } else {
      await failRun(run.id, reauth.error || `reauth ${reauth.status}`);
      log(`Run ${run.id} reauth ended '${reauth.status}'`);
    }
    return true;
  }

  if (isSupportWarmEnabled() && capability.slug === "runyard-support-agent") {
    await event(run.id, "runner.warm_support", `Answering support chat via warm claude on ${runnerName}`, { runnerId });
    const reply = await warmSupportReplyFn(run.input || {});
    await client.post(`/api/runs/${run.id}/complete`, { output: { outputs: { support: { reply } } } });
    log(`Completed ${run.id} via warm support`);
    return true;
  }

  return false;
}
