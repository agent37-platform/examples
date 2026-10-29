/**
 * Typed shapes for the Agent37 Agents API, transcribed from the live spec at
 * https://www.agent37.com/docs/llms-full.txt (and the /docs/agents-api/streaming page).
 * These are the wire shapes; our own domain types live in features/tasks/types.ts.
 */

export interface Agent37ErrorBody {
  code: string;
  message: string;
  param?: string;
  hint?: string;
}

// ---- Hosting API: instances ----

export type InstanceStatus =
  | 'provisioning'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'starting'
  | 'restarting'
  | 'updating'
  | 'failed'
  | 'deleting'
  | 'deleted';

export interface InstancePort {
  port: number;
  default?: boolean;
  url: string;
}

export interface Instance {
  id: string;
  status: InstanceStatus;
  template: string;
  image_ref?: string;
  resources?: { cpu: number; memory: number; disk: number };
  ports?: InstancePort[];
  user?: string;
  name?: string;
  metadata?: Record<string, unknown> | null;
  paid_through?: number;
  past_due?: boolean;
  created?: number;
}

export interface CreateInstanceInput {
  template?: string;
  resources?: { cpu: number; memory: number; disk: number };
  user?: string;
  name?: string;
  metadata?: Record<string, unknown>;
  budget?: { monthly_cap_micros?: number; topup_micros?: number };
}

// ---- Agent API: models ----

export interface ModelInfo {
  id: string;
  label?: string;
  provider?: string;
  description?: string;
}

export interface ModelsResponse {
  default_model?: string;
  default_provider?: string;
  data: ModelInfo[];
}

// ---- Agent API: responses ----

export type ResponseStatus = 'in_progress' | 'completed' | 'failed' | 'cancelled';

export interface ResponseUsage {
  input_tokens?: number;
  output_tokens?: number;
  cost_usd?: number;
}

export interface ResponseObject {
  id: string;
  session_id: string;
  status: ResponseStatus;
  agent?: string;
  model?: string | null;
  provider?: string | null;
  output_text: string;
  usage?: ResponseUsage | null;
  error?: Agent37ErrorBody | null;
  metadata?: Record<string, unknown> | null;
  created?: number;
}

export interface CreateResponseInput {
  input: string;
  files?: string[];
  session_id?: string;
  stream?: boolean;
  model?: string;
  provider?: string;
  thinking?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  metadata?: Record<string, unknown>;
  agent?: string;
  mode?: 'chat' | 'goal';
}

// ---- Agent API: sessions ----

export interface SessionSummary {
  id: string;
  agent?: string;
  model?: string;
  provider?: string;
  created?: number | string;
  last_response_at?: number | string;
}

export interface SessionMessage {
  id: string;
  session_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  thinking?: string;
  created_at?: number | string;
}

export interface SessionDetail {
  id: string;
  session_id?: string;
  history: SessionMessage[];
}

// ---- Agent API: files ----

export interface FileUploadResult {
  path: string;
  filename: string;
  bytes: number;
}

// ---- Streaming (SSE) ----

export type SseEventName =
  | 'response.created'
  | 'response.reasoning.delta'
  | 'response.output_text.delta'
  | 'response.tool_call.started'
  | 'response.tool_call.completed'
  | 'response.tool_call.failed'
  | 'response.completed'
  | 'response.failed';

export interface SseFrame {
  event: string;
  data: unknown;
}

export interface CreatedEventData {
  id: string;
  session_id: string;
}
export interface TextDeltaEventData {
  text: string;
}
export interface ToolCallEventData {
  tool: string;
  label?: string;
  duration_ms?: number;
  error?: string;
}
export interface CompletedEventData {
  output_text: string;
  usage?: ResponseUsage;
}
export interface FailedEventData {
  error: Agent37ErrorBody;
}
