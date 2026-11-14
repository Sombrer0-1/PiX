import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall, getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai";

const response = (name, args) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

function messageText(message) {
	const content = message?.content;
	const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((item) => item.type === "text" ? item.text : "").join(" ") : "";
	return text.replace(/<acp\b[^>]*>.*?<\/acp>/gs, "").trim();
}

function tuiDemo(last) {
	if (last?.role === "toolResult" && last.toolName === "read") {
		if (last.isError) {
			return fauxAssistantMessage([
				fauxThinking("第二个文件不存在，可以给出结论。"),
				fauxText("项目说明已读取。请求的另一个文件不存在。"),
			]);
		}
		return fauxAssistantMessage([
			fauxThinking("项目说明已经读到，接下来读取一个不存在的文件。"),
			fauxToolCall("read", { path: "不存在的文件.txt" }),
		], { stopReason: "toolUse" });
	}
	return fauxAssistantMessage([
		fauxThinking("先读取项目说明，再确认一个不存在的文件。"),
		fauxToolCall("read", { path: "项目说明.txt" }),
	], { stopReason: "toolUse" });
}

export default function extension(pi) {
	const faux = registerFauxProvider({
		provider: "pix-test",
		models: [{ id: "test" }],
		...(process.env.PIX_TEST_TUI_STREAM === "1" ? { tokensPerSecond: 2 } : {}),
	});
	const model = faux.getModel();
	pi.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		apiKey: "$PIX_TEST_KEY",
		api: faux.api,
		models: faux.models,
		streamSimple: getApiProvider(faux.api).streamSimple,
	});
	const run = () => response("workflow", {
		meta: { name: "test-worker", description: "Run a child in the compiled worker" },
		script: 'return await settled("Run the worker child", { maxTurns: 2 });',
	});
	const generate = () => (context, options) => {
		const last = context.messages.at(-1);
		const text = messageText(last);
		const sawTuiDemo = context.messages.some((message) => messageText(message) === "tui demo");
		if (last?.role === "toolResult") {
			if (sawTuiDemo && last.toolName === "read") return tuiDemo(last);
			return fauxAssistantMessage(`Result from ${last.toolName}`);
		}
		if (options?.apiKey !== "test-cli-key") throw new Error("Test runtime credential is missing");
		if (text === "tui demo") return tuiDemo(last);
		if (text.includes("Run the worker child") || text.includes("Run the delegated child") || text.includes("Verify a change")) {
			return fauxAssistantMessage("child completed");
		}
		if (text === "draft plan") {
			const generation = context.messages.map(messageText).reverse().map((line) => /<plan_generation generation_id="([^"]+)"/.exec(line)).find(Boolean);
			if (generation) return response("submit_user_plan", {
				generationId: generation[1], title: "Verify a change", summary: "Delegate the verification to one agent.",
				steps: [{
					stepKey: "verify", title: "Verify a change", description: "Verify a change in the project.",
					scopeNote: "No filesystem changes.", executionTarget: "subagent_background", risk: "low", riskReason: "Read-only.",
					effort: "small", verification: "The delegated agent reports completion.", dependsOn: [],
				}],
			});
		}
		if (text.startsWith("<plan_context") && text.includes('status="executing"')) {
			const ref = /plan_id="([^"]+)" version="(\d+)"[\s\S]*?stepId=([^\s)]+)/.exec(text);
			if (ref) return response("update_plan_step", { planId: ref[1], version: Number(ref[2]), stepId: ref[3], status: "completed", completionSummary: "Verified.", verificationResult: { status: "passed", summary: "Child reported completion." } });
		}
		if (text === "delegate" || text === "delegate foreground") {
			return response("agent", { prompt: "Run the delegated child", run_in_background: text === "delegate" });
		}
		if (text === "workflow") return run();
		if (text === "ask") return response("request_user_input", { questions: [{ id: "answer", header: "Input", question: "What should I use?" }] });
		if (text === "approve child" || text === "approve background child") {
			return response("agent", { prompt: "Run a write requiring approval", run_in_background: text === "approve background child" });
		}
		if (text.includes("Run a write requiring approval")) return response("write", { path: "../approval-marker.txt", content: "Approved" });
		if (text.startsWith("<") && text.includes("允许执行")) return fauxAssistantMessage('```json\n{"approval":"允许执行"}\n```');
		if (text === "mcp") return response("mcp__fixture__ping", {});
		if (text.includes("ACP check")) return response("decompress", { blockId: "b1", inline: true });
		if (text === "todo") return response("todo_write", { todos: [{ content: "Verify the test", status: "pending" }] });
		return fauxAssistantMessage("PiX test response");
	};
	faux.setResponses(Array.from({ length: 30 }, generate));
}
