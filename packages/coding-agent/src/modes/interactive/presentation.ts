export type ToolPhase = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "no-result";
export type ToolDisplayStatus = ToolPhase | "waiting-input" | "background" | "interrupted";

export interface InteractiveToolSnapshot {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly args: unknown;
	readonly phase: ToolPhase;
	readonly result?: Readonly<{
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: unknown;
		isError: boolean;
	}>;
}

export interface InteractiveToolDescription {
	readonly status?: ToolDisplayStatus;
	readonly subject?: string;
	readonly progress?: string;
	readonly diagnostic?: string;
	readonly details?: () => string | undefined;
}

export interface InteractivePresentationUpdate {
	readonly toolCallIds?: readonly string[];
	readonly pendingNotice?: string | null;
	readonly consumeText?: boolean;
}

export interface InteractivePresentation {
	acceptHostEvent(event: Readonly<{ type: string }>): InteractivePresentationUpdate | undefined;
	describeTool(tool: InteractiveToolSnapshot): InteractiveToolDescription | undefined;
}

export type InteractivePresentationFactory = () => InteractivePresentation;

export interface HistoryItem {
	readonly id: string;
	readonly kind: "user" | "assistant" | "thinking" | "tool" | "error";
	readonly label: string;
	readonly detail?: () => string;
}
