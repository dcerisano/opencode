import { castDraft, produce, type WritableDraft } from "immer"
import { Effect } from "effect"
import { SessionEvent } from "./event"
import { SessionMessage } from "./message"

export type MemoryState = {
  messages: SessionMessage.Message[]
}

export interface Adapter {
  readonly getCurrentAssistant: () => Effect.Effect<SessionMessage.Assistant | undefined>
  readonly getAssistant: (messageID: SessionMessage.ID) => Effect.Effect<SessionMessage.Assistant | undefined>
  readonly getCurrentShell: (callID: string) => Effect.Effect<SessionMessage.Shell | undefined>
  readonly updateAssistant: (assistant: SessionMessage.Assistant) => Effect.Effect<void>
  readonly updateShell: (shell: SessionMessage.Shell) => Effect.Effect<void>
  readonly appendMessage: (message: SessionMessage.Message) => Effect.Effect<void>
}

export function memory(state: MemoryState): Adapter {
  const assistantIndex = (messageID: SessionMessage.ID) =>
    state.messages.findLastIndex((message) => message.id === messageID)
  // A newer turn supersedes stale incomplete rows; never resume an older assistant projection.
  const latestAssistantIndex = () => state.messages.findLastIndex((message) => message.type === "assistant")
  const activeShellIndex = (callID: string) =>
    state.messages.findLastIndex((message) => message.type === "shell" && message.callID === callID)

  return {
    getCurrentAssistant() {
      return Effect.sync(() => {
        const index = latestAssistantIndex()
        const assistant = state.messages[index]
        return index < 0 || assistant?.type !== "assistant" || assistant.time.completed ? undefined : assistant
      })
    },
    getAssistant(messageID) {
      return Effect.sync(() => {
        const index = assistantIndex(messageID)
        const assistant = state.messages[index]
        return index < 0 || assistant?.type !== "assistant" ? undefined : assistant
      })
    },
    getCurrentShell(callID) {
      return Effect.sync(() => {
        const index = activeShellIndex(callID)
        const shell = state.messages[index]
        return index < 0 || shell?.type !== "shell" ? undefined : shell
      })
    },
    updateAssistant(assistant) {
      return Effect.sync(() => {
        const index = assistantIndex(assistant.id)
        if (index < 0) return
        const current = state.messages[index]
        if (current?.type !== "assistant") return
        state.messages[index] = assistant
      })
    },
    updateShell(shell) {
      return Effect.sync(() => {
        const index = activeShellIndex(shell.callID)
        if (index < 0) return
        const current = state.messages[index]
        if (current?.type !== "shell") return
        state.messages[index] = shell
      })
    },
    appendMessage(message) {
      return Effect.sync(() => {
        state.messages.push(message)
      })
    },
  }
}

export function update(adapter: Adapter, event: SessionEvent.Event) {
  type DraftAssistant = WritableDraft<SessionMessage.Assistant>
  type DraftTool = WritableDraft<SessionMessage.AssistantTool>
  type DraftText = WritableDraft<SessionMessage.AssistantText>
  type DraftReasoning = WritableDraft<SessionMessage.AssistantReasoning>

  const latestTool = (assistant: DraftAssistant | undefined, callID?: string) =>
    assistant?.content.findLast(
      (item): item is DraftTool => item.type === "tool" && (callID === undefined || item.id === callID),
    )

  const latestText = (assistant: DraftAssistant | undefined, textID: string) =>
    assistant?.content.findLast((item): item is DraftText => item.type === "text" && item.id === textID)

  const latestReasoning = (assistant: DraftAssistant | undefined, reasoningID: string) =>
    assistant?.content.findLast((item): item is DraftReasoning => item.type === "reasoning" && item.id === reasoningID)

  const updateOwnedAssistant = (messageID: SessionMessage.ID, recipe: (draft: DraftAssistant) => void) =>
    Effect.gen(function* () {
      const assistant = yield* adapter.getAssistant(messageID)
      if (assistant) yield* adapter.updateAssistant(produce(assistant, recipe))
    })

  return Effect.gen(function* () {
    yield* SessionEvent.All.match(event, {
      "session.next.agent.switched": (event) => {
        return adapter.appendMessage(
          SessionMessage.AgentSwitched.make({
            id: event.data.messageID,
            type: "agent-switched",
            metadata: event.metadata,
            agent: event.data.agent,
            time: { created: event.data.timestamp },
          }),
        )
      },
      "session.next.model.switched": (event) => {
        return adapter.appendMessage(
          SessionMessage.ModelSwitched.make({
            id: event.data.messageID,
            type: "model-switched",
            metadata: event.metadata,
            model: event.data.model,
            time: { created: event.data.timestamp },
          }),
        )
      },
      "session.next.moved": () => Effect.void,
      "session.next.prompted": (event) => {
        return adapter.appendMessage(
          SessionMessage.User.make({
            id: event.data.messageID,
            type: "user",
            metadata: event.metadata,
            text: event.data.prompt.text,
            files: event.data.prompt.files,
            agents: event.data.prompt.agents,
            time: { created: event.data.timestamp },
          }),
        )
      },
      "session.next.prompt.admitted": () => Effect.void,
      "session.next.context.updated": (event) =>
        adapter.appendMessage(
          SessionMessage.System.make({
            id: event.data.messageID,
            type: "system",
            text: event.data.text,
            time: { created: event.data.timestamp },
          }),
        ),
      "session.next.synthetic": (event) => {
        return adapter.appendMessage(
          SessionMessage.Synthetic.make({
            sessionID: event.data.sessionID,
            text: event.data.text,
            id: event.data.messageID,
            type: "synthetic",
            time: { created: event.data.timestamp },
          }),
        )
      },
      "session.next.shell.started": (event) => {
        return adapter.appendMessage(
          SessionMessage.Shell.make({
            id: event.data.messageID,
            type: "shell",
            metadata: event.metadata,
            callID: event.data.callID,
            command: event.data.command,
            output: "",
            time: { created: event.data.timestamp },
          }),
        )
      },
      "session.next.shell.ended": (event) => {
        return Effect.gen(function* () {
          const currentShell = yield* adapter.getCurrentShell(event.data.callID)
          if (currentShell) {
            yield* adapter.updateShell(
              produce(currentShell, (draft) => {
                draft.output = event.data.output
                draft.time.completed = event.data.timestamp
              }),
            )
          }
        })
      },
      "session.next.step.started": (event) => {
        return Effect.gen(function* () {
          const currentAssistant = yield* adapter.getCurrentAssistant()
          if (currentAssistant) {
            yield* adapter.updateAssistant(
              produce(currentAssistant, (draft) => {
                draft.time.completed = event.data.timestamp
              }),
            )
          }
          yield* adapter.appendMessage(
            SessionMessage.Assistant.make({
              id: event.data.assistantMessageID,
              type: "assistant",
              agent: event.data.agent,
              model: event.data.model,
              time: { created: event.data.timestamp },
              content: [],
              snapshot: event.data.snapshot ? { start: event.data.snapshot } : undefined,
            }),
          )
        })
      },
      "session.next.step.ended": (event) => {
        return updateOwnedAssistant(event.data.assistantMessageID, (draft) => {
          draft.time.completed = event.data.timestamp
          draft.finish = event.data.finish
          draft.cost = event.data.cost
          draft.tokens = event.data.tokens
          if (event.data.snapshot || event.data.files)
            draft.snapshot = {
              ...draft.snapshot,
              end: event.data.snapshot,
              files: event.data.files ? Array.from(event.data.files) : undefined,
            }
        })
      },
      "session.next.step.failed": (event) => {
        return updateOwnedAssistant(event.data.assistantMessageID, (draft) => {
          draft.time.completed = event.data.timestamp
          draft.finish = "error"
          draft.error = event.data.error
        })
      },
      "session.next.text.started": (event) => {
        return updateOwnedAssistant(event.data.assistantMessageID, (draft) => {
          draft.content.push(
            castDraft(SessionMessage.AssistantText.make({ type: "text", id: event.data.textID, text: "" })),
          )
        })
      },
      // Text deltas are not written to the durable store: `session.next.text.ended`
      // carries the full authoritative text and overwrites the part in one write,
      // so per-delta accumulation would only add O(n²) string concat plus a DB
      // SELECT and full-row UPDATE for every token. The durable row is read for
      // context only after the step ends, so nothing observes the intermediate
      // state. Live clients stream the deltas directly from the event stream.
      "session.next.text.delta": () => Effect.void,
      "session.next.text.ended": (event) => {
        return updateOwnedAssistant(event.data.assistantMessageID, (draft) => {
          const match = latestText(draft, event.data.textID)
          if (match) match.text = event.data.text
        })
      },
      "session.next.tool.input.started": (event) => {
        return updateOwnedAssistant(event.data.assistantMessageID, (draft) => {
          draft.content.push(
            castDraft(
              SessionMessage.AssistantTool.make({
                type: "tool",
                id: event.data.callID,
                name: event.data.name,
                time: { created: event.data.timestamp },
                state: SessionMessage.ToolStatePending.make({ status: "pending", input: "" }),
              }),
            ),
          )
        })
      },
      "session.next.tool.input.delta": () => Effect.void,
      "session.next.tool.input.ended": (event) => {
        return updateOwnedAssistant(event.data.assistantMessageID, (draft) => {
          const match = latestTool(draft, event.data.callID)
          if (match && match.state.status === "pending") match.state.input = event.data.text
        })
      },
      "session.next.tool.called": (event) => {
        return updateOwnedAssistant(event.data.assistantMessageID, (draft) => {
          const match = latestTool(draft, event.data.callID)
          if (match) {
            match.provider = event.data.provider
            match.time.ran = event.data.timestamp
            match.state = castDraft(
              SessionMessage.ToolStateRunning.make({
                status: "running",
                input: event.data.input,
                structured: {},
                content: [],
              }),
            )
          }
        })
      },
      "session.next.tool.progress": (event) => {
        return updateOwnedAssistant(event.data.assistantMessageID, (draft) => {
          const match = latestTool(draft, event.data.callID)
          if (match && match.state.status === "running") {
            match.state.structured = event.data.structured
            match.state.content = [...event.data.content]
          }
        })
      },
      "session.next.tool.success": (event) => {
        return updateOwnedAssistant(event.data.assistantMessageID, (draft) => {
          const match = latestTool(draft, event.data.callID)
          if (match && match.state.status === "running") {
            match.provider = {
              executed: event.data.provider.executed || match.provider?.executed === true,
              metadata: match.provider?.metadata,
              resultMetadata: event.data.provider.metadata,
            }
            match.time.completed = event.data.timestamp
            match.state = castDraft(
              SessionMessage.ToolStateCompleted.make({
                status: "completed",
                input: match.state.input,
                structured: event.data.structured,
                content: [...event.data.content],
                outputPaths: event.data.outputPaths ? [...event.data.outputPaths] : [],
                result: event.data.result,
              }),
            )
          }
        })
      },
      "session.next.tool.failed": (event) => {
        return updateOwnedAssistant(event.data.assistantMessageID, (draft) => {
          const match = latestTool(draft, event.data.callID)
          if (match && (match.state.status === "pending" || match.state.status === "running")) {
            match.provider = {
              executed: event.data.provider.executed || match.provider?.executed === true,
              metadata: match.provider?.metadata,
              resultMetadata: event.data.provider.metadata,
            }
            match.time.completed = event.data.timestamp
            match.state = castDraft(
              SessionMessage.ToolStateError.make({
                status: "error",
                error: event.data.error,
                input: typeof match.state.input === "string" ? {} : match.state.input,
                structured: match.state.status === "running" ? match.state.structured : {},
                content: match.state.status === "running" ? match.state.content : [],
                result: event.data.result,
              }),
            )
          }
        })
      },
      "session.next.reasoning.started": (event) => {
        return updateOwnedAssistant(event.data.assistantMessageID, (draft) => {
          draft.content.push(
            castDraft(
              SessionMessage.AssistantReasoning.make({
                type: "reasoning",
                id: event.data.reasoningID,
                text: "",
                providerMetadata: event.data.providerMetadata,
                time: { created: event.data.timestamp },
              }),
            ),
          )
        })
      },
      // Reasoning deltas are not written to the durable store: `session.next.reasoning.ended`
      // carries the full authoritative text and finalizes the part in one write, so
      // per-delta accumulation would only add O(n²) concat plus a DB SELECT and
      // full-row UPDATE for every token. Live clients stream deltas directly.
      "session.next.reasoning.delta": () => Effect.void,
      "session.next.reasoning.ended": (event) => {
        return updateOwnedAssistant(event.data.assistantMessageID, (draft) => {
          const match = latestReasoning(draft, event.data.reasoningID)
          if (match) {
            match.text = event.data.text
            match.time = { created: match.time?.created ?? event.data.timestamp, completed: event.data.timestamp }
            if (event.data.providerMetadata !== undefined) match.providerMetadata = event.data.providerMetadata
          }
        })
      },
      "session.next.retried": () => Effect.void,
      "session.next.compaction.started": () => Effect.void,
      "session.next.compaction.delta": () => Effect.void,
      "session.next.compaction.ended": (event) => {
        return adapter.appendMessage(
          SessionMessage.Compaction.make({
            id: event.data.messageID,
            type: "compaction",
            metadata: event.metadata,
            reason: event.data.reason,
            summary: event.data.text,
            recent: event.data.recent,
            time: { created: event.data.timestamp },
          }),
        )
      },
      "session.next.revert.staged": () => Effect.void,
      "session.next.revert.cleared": () => Effect.void,
      "session.next.revert.committed": () => Effect.void,
    })
  })
}

export * as SessionMessageUpdater from "./message-updater"
