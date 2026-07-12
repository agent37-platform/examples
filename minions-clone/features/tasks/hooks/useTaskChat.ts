'use client';

/**
 * Drives the multi-turn chat thread on a task's Agent37 session. Owns the rendered message list,
 * the live stream (first-turn kickoff / reattach, plus follow-up turns), and the task's lifecycle
 * controls (rename, mark complete, reopen, cancel). All streaming goes through the shared
 * runTaskStream core; this hook only translates its callbacks into mutations of the single "live"
 * assistant message so the UI re-renders token-by-token.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  cancelTask,
  generateTitle,
  updateTask,
} from '@/features/tasks/api/client';
import { runTaskStream, type StreamErrorBody } from '@/features/tasks/lib/stream';
import type { TaskStatus, TaskWithMessages } from '@/features/tasks/types';

export type LivePhase = 'idle' | 'connecting' | 'streaming' | 'completed' | 'failed';

export interface UiTool {
  id: number;
  tool: string;
  label?: string;
  state: 'started' | 'completed' | 'failed';
}

/** One rendered turn. `pending` marks the assistant bubble currently receiving tokens. */
export interface UiMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  reasoning: string;
  tools: UiTool[];
  pending: boolean;
}

export interface UseTaskChatResult {
  messages: UiMessage[];
  status: TaskStatus;
  livePhase: LivePhase;
  error?: StreamErrorBody;
  title: string;
  sending: boolean;
  send: (input: string) => Promise<void>;
  cancel: () => Promise<void>;
  markComplete: () => Promise<void>;
  reopen: () => Promise<void>;
  rename: (next: string) => Promise<void>;
}

function initialMessages(task: TaskWithMessages): UiMessage[] {
  return task.messages.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    reasoning: m.reasoning ?? '',
    tools: [],
    pending: false,
  }));
}

export function useTaskChat({ task }: { task: TaskWithMessages }): UseTaskChatResult {
  const [messages, setMessages] = useState<UiMessage[]>(() => initialMessages(task));
  const [status, setStatus] = useState<TaskStatus>(task.status);
  const [livePhase, setLivePhase] = useState<LivePhase>('idle');
  const [error, setError] = useState<StreamErrorBody | undefined>(undefined);
  const [title, setTitle] = useState<string>(task.title);
  const [sending, setSending] = useState(false);

  // One stream at a time. Refs because handlers/closures read these between renders.
  const abortRef = useRef<AbortController | null>(null);
  const liveIdRef = useRef<string>(''); // id of the assistant message receiving tokens
  const liveActiveRef = useRef<boolean>(false); // is that message still pending?
  const toolIndexRef = useRef<Map<string, number>>(new Map());
  const msgSeq = useRef(0);
  const toolSeq = useRef(0);
  const titleGuard = useRef(false); // generate the title at most once
  const statusRef = useRef<TaskStatus>(task.status);
  const sendingRef = useRef(false);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const nextMsgId = useCallback(() => `ui-${++msgSeq.current}`, []);

  // ----- mutators targeting the single live assistant message -----

  const patchLive = useCallback((patch: (m: UiMessage) => UiMessage) => {
    setMessages((prev) => prev.map((m) => (m.id === liveIdRef.current ? patch(m) : m)));
  }, []);

  const upsertTool = useCallback(
    (tool: string, label: string | undefined, state: UiTool['state']) => {
      const key = `${tool}::${label ?? ''}`;
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== liveIdRef.current) return m;
          const existing = toolIndexRef.current.get(key);
          if (existing !== undefined) {
            return { ...m, tools: m.tools.map((t) => (t.id === existing ? { ...t, state } : t)) };
          }
          const id = ++toolSeq.current;
          toolIndexRef.current.set(key, id);
          return { ...m, tools: [...m.tools, { id, tool, label, state }] };
        }),
      );
    },
    [],
  );

  const maybeGenerateTitle = useCallback(() => {
    // Only after the very first assistant turn, and only if a title wasn't already generated.
    if (titleGuard.current || task.titleGenerated) return;
    titleGuard.current = true;
    generateTitle(task.id)
      .then((res) => {
        if (res?.title) setTitle(res.title);
      })
      .catch(() => {
        // Title is a nicety; a failure here never blocks the thread.
      });
  }, [task.id, task.titleGenerated]);

  // ----- the stream driver -----

  const startStream = useCallback(
    async (opts: { url: string; method?: 'GET' | 'POST'; body?: unknown }): Promise<void> => {
      // Abort any prior stream — only one runs at a time.
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      // Reuse the existing pending assistant message (reconnect / StrictMode remount) or open a
      // fresh one. The id is computed here, outside setState, so the updater stays pure.
      let liveId: string;
      if (liveActiveRef.current && liveIdRef.current) {
        liveId = liveIdRef.current;
      } else {
        liveId = nextMsgId();
        liveIdRef.current = liveId;
        liveActiveRef.current = true;
        setMessages((prev) => [
          ...prev,
          { id: liveId, role: 'assistant', content: '', reasoning: '', tools: [], pending: true },
        ]);
      }
      toolIndexRef.current.clear();

      setError(undefined);
      setStatus('running');
      setLivePhase('connecting');

      const outcome = await runTaskStream({
        url: opts.url,
        method: opts.method ?? 'POST',
        body: opts.body,
        signal: controller.signal,
        handlers: {
          // A fresh connection replays from the start, so clear accumulators to avoid duplicates.
          onOpen: () => {
            toolIndexRef.current.clear();
            patchLive((m) => ({ ...m, content: '', reasoning: '', tools: [] }));
          },
          onReasoning: (text) => patchLive((m) => ({ ...m, reasoning: m.reasoning + text })),
          onOutput: (text) => patchLive((m) => ({ ...m, content: m.content + text })),
          onTool: (tool, label, state) => upsertTool(tool, label, state),
          onCreated: () => {
            setStatus('running');
            setLivePhase('streaming');
          },
          onPhase: (phase) => setLivePhase(phase),
          onCompleted: (outputText) => {
            liveActiveRef.current = false;
            patchLive((m) => ({ ...m, content: outputText, pending: false }));
            setLivePhase('completed');
            setStatus('ready_for_review');
            maybeGenerateTitle();
          },
          onFailed: (err) => {
            liveActiveRef.current = false;
            patchLive((m) => ({ ...m, pending: false }));
            setError(err);
            setLivePhase('failed');
            setStatus('failed');
          },
        },
      });

      // Transport-level failures resolve as 'error' without an onFailed frame; surface them.
      if (outcome.status === 'error') {
        liveActiveRef.current = false;
        patchLive((m) => ({ ...m, pending: false }));
        setError(outcome.error);
        setLivePhase('failed');
        setStatus('failed');
      }
      // 'aborted' is left to cancel()/unmount; 'terminal' was handled by the callbacks above.
    },
    [nextMsgId, patchLive, upsertTool, maybeGenerateTitle],
  );

  // Kick off (or reattach to) the first turn for a queued/running task on mount.
  useEffect(() => {
    if (task.status === 'queued' || task.status === 'running') {
      void startStream({ url: `/api/tasks/${task.id}/stream`, method: 'POST' });
    }
    return () => {
      abortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ----- public actions -----

  const send = useCallback(
    async (input: string) => {
      const text = input.trim();
      if (!text) return;
      if (statusRef.current === 'running' || sendingRef.current) return;

      sendingRef.current = true;
      setSending(true);
      setMessages((prev) => [
        ...prev,
        { id: nextMsgId(), role: 'user', content: text, reasoning: '', tools: [], pending: false },
      ]);
      try {
        await startStream({ url: `/api/tasks/${task.id}/messages`, method: 'POST', body: { input: text } });
      } finally {
        sendingRef.current = false;
        setSending(false);
      }
    },
    [task.id, startStream, nextMsgId],
  );

  const cancel = useCallback(async () => {
    try {
      await cancelTask(task.id);
    } catch {
      // The local abort below still stops the render loop even if the API call fails.
    } finally {
      abortRef.current?.abort();
      liveActiveRef.current = false;
      patchLive((m) => ({ ...m, pending: false }));
      setLivePhase('idle');
      setStatus('cancelled');
    }
  }, [task.id, patchLive]);

  const markComplete = useCallback(async () => {
    const updated = await updateTask(task.id, { status: 'completed' });
    setStatus(updated.status);
  }, [task.id]);

  const reopen = useCallback(async () => {
    const updated = await updateTask(task.id, { status: 'ready_for_review' });
    setStatus(updated.status);
  }, [task.id]);

  const rename = useCallback(
    async (next: string) => {
      const clean = next.trim();
      if (!clean || clean === title) return;
      setTitle(clean); // optimistic
      try {
        const updated = await updateTask(task.id, { title: clean });
        if (updated.title) setTitle(updated.title);
      } catch {
        setTitle(title); // revert on failure
      }
    },
    [task.id, title],
  );

  return { messages, status, livePhase, error, title, sending, send, cancel, markComplete, reopen, rename };
}
