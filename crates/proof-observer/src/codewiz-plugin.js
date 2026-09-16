// Proof-owned passive Codewiz plugin. No SDK calls, prompt changes or tools.
import { spawn } from "node:child_process";

const helper = __PROOF_HELPER__;
const registration = __PROOF_REGISTRATION__;
const maxText = 32768;
const text = (value) => typeof value === "string" ? value.slice(0, maxText) : undefined;
const id = (value) => typeof value === "string" && value.length > 0 && value.length <= 256 ? value : undefined;
const remember = (map, key, value, limit = 512) => {
  if (!key) return;
  map.delete(key);
  map.set(key, value);
  if (map.size > limit) map.delete(map.keys().next().value);
};

export default async function ProofObserver({ directory }) {
  if (typeof directory !== "string") return {};
  const messages = new Map();
  const replies = new Map();
  const finished = new Map();
  const tools = new Map();
  const deliveries = new Set();
  let pending = 0;
  const send = async (event) => {
    if (!id(event.session_id) || pending >= 8) return;
    pending++;
    let finish;
    const delivery = new Promise((resolve) => { finish = resolve; });
    deliveries.add(delivery);
    try {
      const input = JSON.stringify({ ...event, cwd: directory });
      if (Buffer.byteLength(input) > 512 * 1024) return;
      await new Promise((resolve) => {
        // The native bridge has its own 50 ms delivery deadline. This outer
        // bound only covers startup failures and kills this child alone.
        const child = spawn(helper, ["bridge", "--registration", registration], {
          stdio: ["pipe", "ignore", "ignore"], timeout: 1000,
        });
        child.on("error", resolve);
        child.on("close", resolve);
        child.stdin.on("error", () => {});
        child.stdin.end(input);
      });
    } catch { /* Observation must not fail a user task or return model feedback. */ }
    finally { pending--; deliveries.delete(delivery); finish(); }
  };
  return {
    dispose: async () => {
      if (!deliveries.size) return;
      let timer;
      try {
        await Promise.race([
          Promise.all([...deliveries]),
          new Promise((resolve) => { timer = setTimeout(resolve, 100); }),
        ]);
      } finally { clearTimeout(timer); }
    },
    "chat.message": async (input, output) => {
      try {
        const message = output?.message;
        const session = id(message?.sessionID) ?? id(input?.sessionID);
        const turn = id(message?.id) ?? id(input?.messageID);
        const prompt = output?.parts?.filter((part) => part.type === "text" && !part.synthetic)
          .map((part) => text(part.text) ?? "").join("\n");
        await send({ hook_event_name: "UserPromptSubmit", session_id: session,
          turn_id: turn, event_id: turn, prompt: text(prompt) });
      } catch { /* No mutation of input/output or task behavior. */ }
    },
    event: async ({ event }) => {
      try {
        const p = event?.properties ?? {};
        if (event.type === "session.created" || event.type === "session.deleted") {
          const session = id(p.info?.id);
          await send({ hook_event_name: event.type === "session.created" ? "SessionStart" : "SessionEnd",
            session_id: session, event_id: session });
        } else if (event.type === "message.updated") {
          const info = p.info;
          if (!info || !id(info.id)) return;
          remember(messages, info.id, { session: id(info.sessionID), parent: id(info.parentID), role: info.role });
          if (info.role === "assistant" && info.time?.completed && info.finish === "stop") {
            if (finished.has(info.id)) return;
            remember(finished, info.id, true);
            const reply = replies.get(info.id);
            await send({ hook_event_name: "Stop", session_id: id(info.sessionID),
              turn_id: id(info.parentID), event_id: info.id,
              last_assistant_message: text(reply ? [...reply.values()].join("\n") : undefined) });
            replies.delete(info.id);
          }
        } else if (event.type === "message.part.updated") {
          const part = p.part;
          if (!part || !id(part.messageID)) return;
          const message = messages.get(part.messageID);
          if (part.type === "text" && part.time?.end) {
            // Keep only native assistant reply text, never reasoning or user text.
            if (message?.role === "assistant") {
              const parts = replies.get(part.messageID) ?? new Map();
              remember(parts, id(part.id), text(part.text), 16);
              remember(replies, part.messageID, parts, 64);
            }
          } else if (part.type === "tool" && ["completed", "error"].includes(part.state?.status)) {
            const state = part.state;
            const key = id(part.callID) && `${part.sessionID}:${part.callID}:${state.status}`;
            if (key && tools.has(key)) return;
            remember(tools, key, true);
            const input = state.input ?? {};
            const response = { stdout: text(state.status === "error" ? state.error : state.output) };
            if (Number.isInteger(state.metadata?.exit)) response.exit_code = state.metadata.exit;
            await send({ hook_event_name: state.status === "error" ? "PostToolUseFailure" : "PostToolUse",
              session_id: id(part.sessionID), turn_id: message?.role === "assistant" ? message.parent : undefined,
              tool_use_id: id(part.callID), tool_name: id(part.tool),
              tool_input: { file_path: text(input.filePath ?? input.file_path ?? input.path),
                command: text(input.command), patch: text(input.patchText) },
              tool_response: response });
          }
        } else if (event.type === "session.error") {
          await send({ hook_event_name: "StopFailure", session_id: id(p.sessionID),
            tool_response: { stderr: text(p.error?.data?.message ?? p.error?.message) } });
        }
      } catch { /* Best-effort passive observation, no returned instructions. */ }
    },
  };
}
