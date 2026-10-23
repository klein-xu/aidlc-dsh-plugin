// AI-DLC bridge for DeepSeek Harness (DSH).
//
// A Host-only profile plugin: it maps DSH's agent and tool events onto the
// AI-DLC engine's own hook spine, so the core hooks (human presence, the four
// guards, audit, sensors, the forwarding loop, session events) run unchanged.
// The engine is spawned through Bun; the plugin imports nothing from DSH
// packages and holds no state the core hooks do not own.
//
// DSH moment -> engine hook (the Claude Code event it mirrors)
// ---------------------------------------------------------------------------
// agent/created                    -> session-start        (SessionStart)
// agent/pre-step, source.kind=user -> record-human-turn    (UserPromptSubmit)
// tools/pre-execute (read/write/edit/glob/grep/bash/subagent)
//                                  -> guard-tool-call      (PreToolUse group)
// tools/post-execute ask_user_question
//                                  -> record-human-turn    (PostToolUse AskUserQuestion)
// tools/post-execute write/edit     -> write-audit-log + run-sensors (PostToolUse Write|Edit)
// tools/post-execute bash          -> rebuild-stage-graph  (PostToolUse Bash)
// subagent/end                     -> log-subagent         (SubagentStop)
// agent/turn-stopping              -> continue-workflow    (Stop)
// agent/disposed                   -> session-end          (SessionEnd)
//
// `aidlc-deliver-stage-rules` is deliberately not wired: DSH cannot rewrite a
// tool call's arguments, so the conductor carries the stage's rules in the
// subagent brief (documented in the README and the harness onboarding).

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";

const ENGINE_TREE = join(".dsh", "tools", "aidlc.ts");
const MESSAGE_SOURCE_KIND = "dsh-aidlc";
const MAX_OUTPUT_BYTES = 1_000_000;
const BUN_RECHECK_MS = 30_000;

// Exported so the loader can name the row in diagnostics, and because a bundle
// plugin is identified by these two exports (see the DSH host-plugin contract).
export const name = "aidlc-dsh-bridge";
export const inject = ["tools"];

const GUARD_RETRY =
  "AI-DLC's safety check returned no reason, so this tool call was stopped. Retry it once; " +
  "if it is stopped again, restart DeepSeek Harness, because the AI-DLC plugin starts this check itself.";

const BOUNDARY_REFUSAL =
  "AI-DLC runs as one direct engine invocation. Run the engine command again without shell " +
  "chaining, pipes, redirection, expansion, or command substitution.";

const BOUNDARY_ENTRY_REFUSAL =
  "Only a shipped AI-DLC entrypoint under .dsh/tools or .dsh/hooks may be run from the engine tree. " +
  "Run the engine through .dsh/tools/aidlc.ts.";

export function apply(ctx, config = {}) {
  const settings = bridgeSettings(config ?? {});
  const logOnce = onceLogger(ctx);
  const state = {
    started: new Set(),
    personaBySession: new Map(),
    subagentRuns: new Map(),
    dispatches: [],
  };

  let bun = { path: undefined, checkedAt: 0 };
  const bunPath = () => {
    const now = Date.now();
    if (bun.path !== undefined && (bun.path !== null || now - bun.checkedAt < BUN_RECHECK_MS)) {
      return bun.path;
    }
    const found = settings.resolveBun();
    bun = { path: found, checkedAt: now };
    return found;
  };

  const runEngine = (root, hook, payload, timeoutMs) =>
    runEngineHook(settings, bunPath, root, hook, payload, timeoutMs);

  const laneRoot = async (agent, signal) => {
    const lane = await laneDirectory(ctx, agent, signal);
    return lane === null ? null : findProjectRoot(lane);
  };

  const humanTurn = (root, sessionId, prompt, timeoutMs) =>
    runEngine(root, "record-human-turn", {
      hook_event_name: "UserPromptSubmit",
      session_id: sessionId,
      prompt,
      cwd: root,
    }, timeoutMs);

  async function onAgentCreated(payload) {
    try {
      const agent = payload?.agent;
      if (!agent || typeof agent.id !== "string") return;
      if (state.started.has(agent.id)) return;
      state.started.add(agent.id);
      // A delegated child runs in its parent's conversation: its calls are
      // forwarded with the parent's session id, so it opens no session of its
      // own (the opencode and cursor adapters draw the same line).
      if (isChildAgent(agent)) return;
      const root = await laneRoot(agent);
      if (root === null) return;
      await runEngine(root, "session-start", {
        hook_event_name: "SessionStart",
        source: typeof payload?.source === "string" ? payload.source : "startup",
        session_id: agent.id,
        cwd: root,
      }, settings.hookTimeoutMs);
    } catch (error) {
      logOnce("agent-created", `agent/created bridge failed: ${errorMessage(error)}`);
    }
  }

  async function onPreStep(payload, next) {
    try {
      const agent = payload?.agent;
      const messages = Array.isArray(payload?.messages) ? payload.messages : [];
      if (!agent || isChildAgent(agent)) return next();
      if (payload?.signal?.aborted) return next();
      const turns = messages.filter((message) => message?.source?.kind === "user");
      if (turns.length === 0) return next();
      const root = await laneRoot(agent, payload?.signal);
      if (root === null) return next();
      for (const message of turns) {
        // The prompt is waited on: the mint must finish before the model acts.
        await humanTurn(root, agent.id, contentText(message.content), settings.hookTimeoutMs);
      }
      return next();
    } catch (error) {
      logOnce("pre-step", `record-human-turn bridge failed: ${errorMessage(error)}`);
      return next();
    }
  }

  async function onPreExecute(exec, next) {
    try {
      if (exec?.signal?.aborted) return next();
      const call = mapToolCall(exec?.name, exec?.arguments);
      if (call === null) return next();
      const agent = exec?.agent;
      if (!agent) return next();
      const lane = await laneDirectory(ctx, agent, exec?.signal);
      if (lane === null) return next();
      const root = findProjectRoot(lane);
      if (root === null) return next();

      let cwd = lane;
      let toolInput = call.toolInput;
      if (call.toolName === "Bash") {
        const command = typeof toolInput.command === "string" ? toolInput.command : "";
        if (typeof toolInput.workdir === "string" && toolInput.workdir.length > 0) {
          cwd = resolve(lane, toolInput.workdir);
        }
        const violation = bashBoundaryViolation(command, root);
        if (violation !== null) return { kind: "deny", reason: violation };
      } else if (call.toolName !== "Task") {
        toolInput = absolutize(toolInput, call.toolName, lane);
      }

      if (call.toolName === "Task") {
        const persona = personaFromText(`${stringField(toolInput.description)} ${stringField(toolInput.prompt)}`);
        // The dispatch record carries the project root too: subagent/start may
        // fire before the child agent is resolvable through ctx.agents.
        rememberDispatch(state, persona, root);
        toolInput = { ...toolInput, ...(persona === null ? {} : { subagent_type: persona }) };
      }

      const guardPayload = {
        hook_event_name: "PreToolUse",
        tool_name: call.toolName,
        tool_input: toolInput,
        session_id: rootSessionId(ctx, agent),
        cwd,
      };
      const identity = agentIdentity(state, agent);
      if (identity !== null) guardPayload.agent_type = identity;
      else if (isChildAgent(agent)) guardPayload.scoped_registration = true;

      const outcome = await runEngine(root, "guard-tool-call", guardPayload, settings.guardTimeoutMs);
      if (outcome.kind === "exit") {
        if (outcome.code === 0) return next();
        if (outcome.code === 2) {
          const reason = outcome.stderr.trim();
          return { kind: "deny", reason: reason.length > 0 ? reason : GUARD_RETRY };
        }
        logOnce("guard-exit", `AIDLC guard process exited ${outcome.code}; the tool call was allowed`);
        return next();
      }
      if (outcome.kind === "timeout") {
        logOnce("guard-timeout", "AIDLC guard check timed out; the tool call was allowed");
        return next();
      }
      if (outcome.kind === "unavailable") {
        logOnce("bun-missing", "Bun was not found, so AI-DLC's checks did not run; install Bun and restart DeepSeek Harness");
        return next();
      }
      logOnce("guard-spawn", "AIDLC guard process could not be started; the tool call was allowed");
      return next();
    } catch (error) {
      logOnce("pre-execute", `AIDLC guard bridge failed: ${errorMessage(error)}`);
      return next();
    }
  }

  async function onPostExecute(exec, result, next) {
    try {
      const tool = exec?.name;
      if (tool === "ask_user_question") {
        await recordPickerAnswer(ctx, exec, result, settings, runEngine);
      } else if (tool === "write" || tool === "edit") {
        await recordWrite(ctx, exec, result, settings, runEngine, logOnce);
      } else if (tool === "bash") {
        await recordBash(ctx, exec, result, settings, runEngine, logOnce);
      } else if (tool === "subagent" || tool === "subagent_fork") {
        reconcileSpawn(state, exec, result);
      }
    } catch (error) {
      logOnce("post-execute", `AI-DLC post-tool bridge failed: ${errorMessage(error)}`);
    }
    return next();
  }

  async function onTurnStopping(payload) {
    try {
      const agent = payload?.agent;
      if (!agent || isChildAgent(agent) || payload?.signal?.aborted) return;
      const root = await laneRoot(agent, payload?.signal);
      if (root === null) return;
      const outcome = await runEngine(root, "continue-workflow", {
        hook_event_name: "Stop",
        stop_hook_active: false,
        session_id: agent.id,
        cwd: root,
      }, settings.stopTimeoutMs);
      if (outcome.kind !== "exit" || outcome.code !== 0) {
        if (outcome.kind === "exit") logOnce("stop-exit", `AIDLC stop check exited ${outcome.code}`);
        else if (outcome.kind === "timeout") logOnce("stop-timeout", "AIDLC stop check timed out");
        else if (outcome.kind === "unavailable") {
          logOnce("bun-missing", "Bun was not found, so AI-DLC's checks did not run; install Bun and restart DeepSeek Harness");
        } else logOnce("stop-spawn", "AIDLC stop check could not be started");
        return;
      }
      const reason = blockReason(outcome.stdout);
      if (reason === null || payload?.signal?.aborted) return;
      // The reason is the core hook's plain carrying-on line; steer keeps the
      // turn open exactly as Claude Code's Stop block does. Loop ceilings stay
      // with the core hook (no counting here). The source is not "user", so the
      // human-turn arm below never treats this steer as the person speaking.
      agent.steer(steerMessage(reason));
    } catch (error) {
      logOnce("stop", `AIDLC stop bridge failed: ${errorMessage(error)}`);
    }
  }

  async function onSubagentStart(info) {
    try {
      if (!info || typeof info.id !== "string") return;
      const dispatch = takeDispatch(state);
      const persona = dispatch?.persona ?? null;
      if (persona !== null) state.personaBySession.set(info.id, persona);
      const child = optionalService(ctx, "agents")?.get?.(info.id);
      const parentSessionId = child?.session?.header?.parentSession;
      const laneAgent = child ?? optionalService(ctx, "agents")?.get?.(parentSessionId);
      const lane = await laneDirectory(ctx, laneAgent);
      const root = lane === null ? (dispatch?.root ?? null) : findProjectRoot(lane);
      state.subagentRuns.set(String(info.runId), {
        persona,
        parentSessionId: typeof parentSessionId === "string" ? parentSessionId : undefined,
        root,
      });
    } catch (error) {
      logOnce("subagent-start", `subagent/start bridge failed: ${errorMessage(error)}`);
    }
  }

  async function onSubagentEnd(info) {
    try {
      if (!info || typeof info.runId !== "string") return;
      const runId = String(info.runId);
      const record = state.subagentRuns.get(runId);
      state.subagentRuns.delete(runId);
      if (record === undefined || record.root === null) return;
      const payload = {
        hook_event_name: "SubagentStop",
        agent_id: runId,
        last_assistant_message: contentText(info.lastAssistantMessage),
        cwd: record.root,
      };
      if (record.persona !== null) payload.agent_type = record.persona;
      if (record.parentSessionId !== undefined) payload.session_id = record.parentSessionId;
      await runEngine(record.root, "log-subagent", payload, settings.hookTimeoutMs);
    } catch (error) {
      logOnce("subagent-end", `subagent/end bridge failed: ${errorMessage(error)}`);
    }
  }

  async function onAgentDisposed(payload) {
    try {
      const agent = payload?.agent;
      if (!agent || typeof agent.id !== "string") return;
      state.personaBySession.delete(agent.id);
      state.started.delete(agent.id);
      const child = isChildAgent(agent);
      if (child) return;
      const root = await laneRoot(agent);
      if (root === null) return;
      await runEngine(root, "session-end", {
        hook_event_name: "SessionEnd",
        reason: "other",
        session_id: agent.id,
        cwd: root,
      }, settings.hookTimeoutMs);
    } catch (error) {
      logOnce("agent-disposed", `agent/disposed bridge failed: ${errorMessage(error)}`);
    }
  }

  ctx.effect(() => {
    const disposers = [
      ctx.on("agent/created", (payload) => onAgentCreated(payload)),
      ctx.on("agent/pre-step", (payload, next) => onPreStep(payload, next)),
      ctx.on("tools/pre-execute", (exec, next) => onPreExecute(exec, next)),
      ctx.on("tools/post-execute", (exec, result, next) => onPostExecute(exec, result, next)),
      ctx.on("agent/turn-stopping", (payload) => onTurnStopping(payload)),
      ctx.on("subagent/start", (info) => onSubagentStart(info)),
      ctx.on("subagent/end", (info) => onSubagentEnd(info)),
      ctx.on("agent/disposed", (payload) => onAgentDisposed(payload)),
    ];
    return () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          // A listener already removed by its own agent teardown is not an error.
        }
      }
    };
  }, "aidlc-dsh-bridge");
}

// --- DSH -> engine plumbing -------------------------------------------------

function bridgeSettings(config) {
  const positive = (value, fallback) =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
  return {
    guardTimeoutMs: positive(config.guardTimeoutMs, 60_000),
    hookTimeoutMs: positive(config.hookTimeoutMs, 120_000),
    postTimeoutMs: positive(config.postTimeoutMs, 300_000),
    stopTimeoutMs: positive(config.stopTimeoutMs, 180_000),
    bunPath: typeof config.bunPath === "string" && config.bunPath.trim().length > 0
      ? config.bunPath.trim()
      : null,
    // Unit-test seams: `spawn` and `resolveBun` let a plain `node --test` run
    // the bridge without a Bun child process. Production uses the defaults.
    spawn: typeof config.spawn === "function" ? config.spawn : spawn,
    resolveBun: typeof config.resolveBun === "function"
      ? config.resolveBun
      : () => findBun(config.bunPath),
  };
}

function runEngineHook(settings, bunPath, root, hook, payload, timeoutMs) {
  const bun = bunPath();
  if (bun === null) return Promise.resolve({ kind: "unavailable" });
  const args = [
    join(root, ".dsh", "tools", "aidlc.ts"),
    "engine",
    "hook",
    hook,
    "--project-dir",
    root,
  ];
  const env = {
    ...process.env,
    AIDLC_PROJECT_DIR: root,
    CLAUDE_PROJECT_DIR: root,
  };
  return new Promise((settle) => {
    let settled = false;
    let child = null;
    let timer = null;
    let stdout = "";
    let stderr = "";
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      try {
        child?.kill?.("SIGKILL");
      } catch {
        // The child already exited.
      }
      settle(outcome);
    };
    const append = (current, chunk) =>
      current.length >= MAX_OUTPUT_BYTES ? current : `${current}${String(chunk)}`.slice(0, MAX_OUTPUT_BYTES);
    try {
      child = settings.spawn(bun, args, { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      finish({ kind: "failed", error });
      return;
    }
    timer = setTimeout(() => finish({ kind: "timeout" }), timeoutMs);
    child?.stdout?.on?.("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    child?.stderr?.on?.("data", (chunk) => {
      stderr = append(stderr, chunk);
    });
    child?.on?.("error", (error) => finish({ kind: "failed", error }));
    child?.on?.("close", (code, signal) =>
      finish({
        kind: "exit",
        code: typeof code === "number" ? code : 1,
        signal: signal ?? null,
        stdout,
        stderr,
      }));
    try {
      child?.stdin?.write?.(JSON.stringify(payload));
      child?.stdin?.end?.();
    } catch {
      // A child that exited before reading its stdin is reported by "close".
    }
  });
}

function findBun(configured) {
  const executable = (candidate) => {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (typeof configured === "string") return executable(configured) ? configured : null;
  const names = process.platform === "win32" ? ["bun.exe", "bun"] : ["bun"];
  for (const entry of (process.env.PATH ?? "").split(delimiter)) {
    if (entry.length === 0) continue;
    for (const name of names) {
      const candidate = join(entry, name);
      if (executable(candidate)) return candidate;
    }
  }
  for (const candidate of [
    join(homedir(), ".bun", "bin", names[0]),
    ...(process.platform === "win32" ? ["/usr/local/bin/bun.exe"] : ["/usr/local/bin/bun"]),
  ]) {
    if (executable(candidate)) return candidate;
  }
  return null;
}

async function laneDirectory(ctx, agent, signal) {
  if (!agent) return null;
  const workingDirectory = optionalService(ctx, "workingDirectory");
  if (workingDirectory !== undefined) {
    try {
      const dir = workingDirectory.get?.(agent.session);
      if (typeof dir === "string" && dir.length > 0) return dir;
    } catch {
      // Fall through to the async resolution.
    }
    try {
      const dir = await workingDirectory.ensure?.(agent, signal);
      if (typeof dir === "string" && dir.length > 0) return dir;
    } catch {
      // Fall through to the session header.
    }
  }
  const cwd = agent?.session?.header?.cwd;
  return typeof cwd === "string" && cwd.length > 0 ? cwd : null;
}

function optionalService(ctx, service) {
  try {
    return ctx.get?.(service);
  } catch {
    return undefined;
  }
}

function findProjectRoot(startDirectory) {
  let dir;
  try {
    dir = resolve(startDirectory);
  } catch {
    return null;
  }
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      if (existsSync(join(dir, ENGINE_TREE))) return dir;
    } catch {
      return null;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function isChildAgent(agent) {
  const header = agent?.session?.header;
  return typeof header?.parentSession === "string" && header.parentSession.length > 0;
}

function rootSessionId(ctx, agent) {
  let current = agent;
  for (let depth = 0; depth < 8; depth += 1) {
    const parentId = current?.session?.header?.parentSession;
    if (typeof parentId !== "string" || parentId.length === 0) return current?.id ?? agent?.id ?? "";
    const parent = optionalService(ctx, "agents")?.get?.(parentId);
    if (parent === undefined || parent === null || parent === current) return parentId;
    current = parent;
  }
  return current?.id ?? "";
}

// --- Tool-call mapping ------------------------------------------------------

function mapToolCall(name, argumentsValue) {
  const args = isRecord(argumentsValue) ? argumentsValue : {};
  switch (name) {
    case "write":
      return { toolName: "Write", toolInput: { file_path: stringField(args.file_path) } };
    case "edit":
      return { toolName: "Edit", toolInput: { file_path: stringField(args.file_path) } };
    case "read":
      return { toolName: "Read", toolInput: { file_path: stringField(args.file_path) } };
    case "glob":
      return {
        toolName: "Glob",
        toolInput: { pattern: stringField(args.pattern), path: stringField(args.path) },
      };
    case "grep":
      return {
        toolName: "Grep",
        toolInput: {
          pattern: stringField(args.pattern),
          path: stringField(args.path),
          glob: stringField(args.include),
        },
      };
    case "bash":
      return {
        toolName: "Bash",
        toolInput: {
          command: stringField(args.command),
          workdir: stringField(args.workdir),
        },
      };
    case "subagent":
    case "subagent_fork":
      return {
        toolName: "Task",
        toolInput: {
          description: stringField(args.description),
          prompt: stringField(args.prompt),
        },
      };
    default:
      return null;
  }
}

function absolutize(toolInput, toolName, lane) {
  const next = { ...toolInput };
  const fields = toolName === "Glob" || toolName === "Grep" ? ["path"] : ["file_path"];
  for (const field of fields) {
    const value = next[field];
    if (typeof value === "string" && value.length > 0 && !isAbsolute(value)) {
      next[field] = resolve(lane, value);
    }
  }
  return next;
}

function personaFromText(text) {
  const match = /\baidlc-[a-z0-9]+(?:-[a-z0-9]+)*-agent\b/.exec(text);
  return match === null ? null : match[0];
}

function rememberDispatch(state, persona, root) {
  const now = Date.now();
  const live = state.dispatches.filter((entry) => now - entry.at < 300_000).slice(-15);
  live.push({ persona, root, at: now });
  state.dispatches = live;
}

function takeDispatch(state) {
  const now = Date.now();
  while (state.dispatches.length > 0 && now - state.dispatches[0].at >= 300_000) {
    state.dispatches.shift();
  }
  return state.dispatches.shift();
}

function reconcileSpawn(state, exec, result) {
  const value = result?.isError === false ? result.value : null;
  const childId = isRecord(value) && typeof value.subagentId === "string" ? value.subagentId : null;
  if (childId === null) return;
  const persona = personaFromText(
    `${stringField(isRecord(exec?.arguments) ? exec.arguments.description : "")} ` +
    `${stringField(isRecord(exec?.arguments) ? exec.arguments.prompt : "")}`,
  );
  if (persona !== null && !state.personaBySession.has(childId)) {
    state.personaBySession.set(childId, persona);
  }
}

function agentIdentity(state, agent) {
  if (!isChildAgent(agent)) return null;
  return state.personaBySession.get(agent.id) ?? null;
}

// --- Post-tool mapping ------------------------------------------------------

async function recordWrite(ctx, exec, result, settings, runEngine, logOnce) {
  // A failed call changed nothing: Claude's PostToolUse does not fire for it either.
  if (result?.isError !== false) return;
  const args = isRecord(exec?.arguments) ? exec.arguments : {};
  const rawPath = stringField(args.file_path);
  if (rawPath.length === 0) return;
  if (exec?.signal?.aborted) return;
  const lane = await laneDirectory(ctx, exec?.agent, exec?.signal);
  if (lane === null) return;
  const root = findProjectRoot(lane);
  if (root === null) return;
  const payload = {
    hook_event_name: "PostToolUse",
    tool_name: exec.name === "edit" ? "Edit" : "Write",
    tool_input: { file_path: isAbsolute(rawPath) ? rawPath : resolve(lane, rawPath) },
    session_id: rootSessionId(ctx, exec?.agent),
    cwd: root,
  };
  // Audit THEN sensors, the Claude registration order.
  await runEngine(root, "write-audit-log", payload, settings.postTimeoutMs);
  const sensors = await runEngine(root, "run-sensors", payload, settings.postTimeoutMs);
  if (sensors.kind === "timeout") logOnce("sensors-timeout", "AIDLC sensor dispatch timed out");
}

async function recordBash(ctx, exec, result, settings, runEngine) {
  if (result?.isError !== false) return;
  const args = isRecord(exec?.arguments) ? exec.arguments : {};
  if (exec?.signal?.aborted) return;
  const lane = await laneDirectory(ctx, exec?.agent, exec?.signal);
  if (lane === null) return;
  const root = findProjectRoot(lane);
  if (root === null) return;
  const payload = {
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: stringField(args.command) },
    tool_response: contentText(result?.content),
    session_id: rootSessionId(ctx, exec?.agent),
    cwd: root,
  };
  await runEngine(root, "rebuild-stage-graph", payload, settings.postTimeoutMs);
}

async function recordPickerAnswer(ctx, exec, result, settings, runEngine) {
  const agent = exec?.agent;
  if (!agent || exec?.signal?.aborted) return;
  if (result?.isError !== false) return;
  const value = isRecord(result.value) ? result.value : {};
  const answers = Array.isArray(value.answers) ? value.answers : [];
  if (answers.length === 0) return;
  const keyed = {};
  for (const answer of answers) {
    if (!isRecord(answer) || typeof answer.id !== "string") continue;
    const picks = (Array.isArray(answer.selected) ? answer.selected : [])
      .filter((pick) => typeof pick === "string" && pick.length > 0);
    if (typeof answer.custom === "string" && answer.custom.length > 0) picks.push(answer.custom);
    keyed[answer.id] = picks;
  }
  if (Object.keys(keyed).length === 0) return;
  const lane = await laneDirectory(ctx, agent, exec?.signal);
  if (lane === null) return;
  const root = findProjectRoot(lane);
  if (root === null) return;
  const args = isRecord(exec.arguments) ? exec.arguments : {};
  // DSH's answer array is keyed by position; the core picker reader looks the
  // question id up in an `answers` map, so normalize the shape here.
  await runEngine(root, "record-human-turn", {
    hook_event_name: "PostToolUse",
    session_id: rootSessionId(ctx, agent),
    cwd: root,
    tool_name: "AskUserQuestion",
    tool_input: { questions: Array.isArray(args.questions) ? args.questions : [] },
    tool_response: { answers: keyed },
  }, settings.hookTimeoutMs);
}

// --- Stop block parsing -----------------------------------------------------

function blockReason(stdout) {
  const text = String(stdout ?? "").trim();
  if (text.length === 0) return null;
  for (const line of text.split(/\r?\n/).reverse()) {
    const reason = blockReasonFromJson(line);
    if (reason !== null) return reason;
  }
  return blockReasonFromJson(text);
}

function blockReasonFromJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (parsed.decision === "block" && typeof parsed.reason === "string" && parsed.reason.trim().length > 0) {
    return parsed.reason;
  }
  // Claude Code 2.1.163+ feedback shape; the core hook uses it only on Claude,
  // but reading it here keeps the bridge tolerant of a different dispatcher.
  const feedback = isRecord(parsed.hookSpecificOutput) ? parsed.hookSpecificOutput.additionalContext : undefined;
  return typeof feedback === "string" && feedback.trim().length > 0 ? feedback : null;
}

function steerMessage(text) {
  return Object.freeze({
    id: randomUUID(),
    role: "user",
    content: Object.freeze([{ type: "text", text }]),
    source: Object.freeze({ kind: MESSAGE_SOURCE_KIND }),
  });
}

// --- Entrypoint boundary ----------------------------------------------------

// Mirrors the opencode adapter's boundary for the one permission prefix AI-DLC
// relies on: an AI-DLC engine invocation is one direct, unwrapped command. DSH
// has no command allowlist to protect, so a command that does not start with
// the engine is not inspected.
function bashBoundaryViolation(command, root) {
  if (typeof command !== "string" || command.trim().length === 0) return null;
  const words = simpleShellWords(command);
  if (words === null) {
    return startsWithEngineInvocation(command) ? BOUNDARY_REFUSAL : null;
  }
  if (words.length === 0) return null;
  if (/(?:^|[\\/])aidlc(?:\.exe|\.cmd)?$/.test(words[0])) return null;
  if (!/(?:^|[\\/])bun(?:\.exe)?$/.test(words[0])) return null;
  const script = words[1];
  if (typeof script !== "string" || script.length === 0) return null;
  const scriptPath = (isAbsolute(script) ? script : resolve(root, script)).replace(/\\/g, "/");
  const rootPath = root.replace(/\\/g, "/").replace(/\/+$/, "");
  if (scriptPath !== rootPath && !scriptPath.startsWith(`${rootPath}/`)) return null;
  const entrypoint = /(?:^|\/)\.dsh\/(?:tools|hooks)\/aidlc(?:-[a-z0-9]+)*\.ts$/.test(scriptPath);
  return entrypoint ? null : BOUNDARY_ENTRY_REFUSAL;
}

function startsWithEngineInvocation(command) {
  return /^[ \t]*(?:aidlc(?=[ \t]|$)|bun(?:\.exe)?[ \t]+(?:\.\/)?(?:\S*[\\/])?\.dsh[\\/](?:tools|hooks)[\\/]aidlc)/.test(command);
}

function simpleShellWords(command) {
  const words = [];
  let word = "";
  let started = false;
  let quote = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote === "'") {
      if (char === "'") quote = null;
      else word += char;
      started = true;
      continue;
    }
    if (quote === '"') {
      if (char === '"') {
        quote = null;
        continue;
      }
      if (char === "\\" && index + 1 < command.length) {
        const next = command[index + 1];
        if (next === "\n" || next === "\r") return null;
        word += next;
        index += 1;
        started = true;
        continue;
      }
      if (char === "`" || char === "$") return null;
      word += char;
      started = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (char === "\\") {
      if (index + 1 >= command.length) return null;
      const next = command[index + 1];
      if (next === "\n" || next === "\r") return null;
      word += next;
      index += 1;
      started = true;
      continue;
    }
    if (char === " " || char === "\t") {
      if (started) {
        words.push(word);
        word = "";
        started = false;
      }
      continue;
    }
    if (
      char === "\n" ||
      char === "\r" ||
      char === ";" ||
      char === "|" ||
      char === "&" ||
      char === "(" ||
      char === ")" ||
      char === "<" ||
      char === ">" ||
      char === "`" ||
      char === "$" ||
      char === "#"
    ) {
      return null;
    }
    word += char;
    started = true;
  }
  if (quote !== null) return null;
  if (started) words.push(word);
  return words;
}

// --- Small helpers ----------------------------------------------------------

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n");
}

function stringField(value) {
  return typeof value === "string" ? value : "";
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function onceLogger(ctx) {
  const seen = new Set();
  return (kind, message) => {
    if (seen.has(kind)) return;
    seen.add(kind);
    try {
      ctx.logger?.warn?.(`aidlc: ${message}`);
    } catch {
      // Logging is best effort; it must never fail the host.
    }
  };
}
