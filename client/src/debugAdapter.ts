import * as vscode from 'vscode';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as path from 'path';
import { 
	DebugProtocol 
} from '@vscode/debugprotocol';
import {
	LoggingDebugSession,
	InitializedEvent,
	TerminatedEvent,
	StoppedEvent,
	OutputEvent
} from '@vscode/debugadapter';

/**
 * Breakpoint mapping between VS Code and SchemaLang debugger
 */
interface BreakpointInfo {
	vscodeId: number;
	debuggerId: number;
	type: 'line' | 'token' | 'struct' | 'enum' | 'file' | 'validation';
	location: string;
	verified: boolean;
}

/**
 * Debugger state tracking
 */
interface DebuggerState {
	isRunning: boolean;
	isPaused: boolean;
	currentFile: string;
	currentLine: number;
	currentColumn: number;
	tokenIndex: number;
	parseStack: string[];
}

/**
 * Variable reference IDs - use ranges to distinguish scope types
 * 1000       = Current Context scope
 * 2000       = Parse Stack scope
 * 3000       = AST scope (root)
 * 3001-3999  = AST struct entries (3000 + 1-based struct index)
 * 4001-4999  = AST enum entries (4000 + 1-based enum index)
 * 5000+      = AST member entries (5000 + structIdx*1000 + memberIdx)
 */
const SCOPE_CONTEXT = 1000;
const SCOPE_PARSE_STACK = 2000;
const SCOPE_AST = 3000;
const SCOPE_AST_STRUCTS_BASE = 3001;
const SCOPE_AST_ENUMS_BASE = 4001;
const SCOPE_AST_MEMBERS_BASE = 5000;

/** Parsed struct info from debugger output */
interface StructInfo {
	name: string;
	version: string;
	memberCount: number;
	members: MemberInfo[];
}

/** Parsed member info */
interface MemberInfo {
	name: string;
	type: string;
	flags: string[];
}

/** Parsed enum info */
interface EnumInfo {
	name: string;
	values: { name: string; value: number }[];
}

/**
 * SchemaLang Debug Adapter implementation
 * Implements the Debug Adapter Protocol (DAP) for SchemaLang debugging
 */
export class SchemaLangDebugSession extends LoggingDebugSession {
	private debuggerProcess: ChildProcessWithoutNullStreams | null = null;
	private breakpoints: Map<string, BreakpointInfo[]> = new Map();
	private nextBreakpointId = 1;
	private state: DebuggerState = {
		isRunning: false,
		isPaused: false,
		currentFile: '',
		currentLine: 0,
		currentColumn: 0,
		tokenIndex: -1,
		parseStack: []
	};
	private outputBuffer = '';
	private commandQueue: Array<{ command: string; resolve: (output: string) => void }> = [];
	private currentCommand: { command: string; resolve: (output: string) => void } | null = null;
	private workspaceRoot: string = '';
	private promptResolvers: Array<() => void> = [];
	private hasPrompt = false;
	private cachedStructs: StructInfo[] = [];
	private cachedEnums: EnumInfo[] = [];
	private astCacheDirty = true;

	constructor() {
		super();
		// Set debug logging
		this.setDebuggerLinesStartAt1(true);
		this.setDebuggerColumnsStartAt1(true);
	}

	/**
	 * Initialize request - first message from client
	 */
	protected initializeRequest(
		response: DebugProtocol.InitializeResponse,
		args: DebugProtocol.InitializeRequestArguments
	): void {
		// Announce capabilities
		response.body = response.body || {};
		response.body.supportsConfigurationDoneRequest = true;
		response.body.supportsEvaluateForHovers = true;
		response.body.supportsStepBack = false;
		response.body.supportsStepInTargetsRequest = false;
		response.body.supportsConditionalBreakpoints = true;
		response.body.supportsHitConditionalBreakpoints = true;
		response.body.supportsBreakpointLocationsRequest = false;
		response.body.supportsSetVariable = false;
		response.body.supportsRestartFrame = false;
		response.body.supportsGotoTargetsRequest = false;
		response.body.supportsCompletionsRequest = false;
		response.body.supportsModulesRequest = false;
		response.body.supportsRestartRequest = false;
		response.body.supportsExceptionOptions = false;
		response.body.supportsValueFormattingOptions = true;
		response.body.supportsExceptionInfoRequest = false;
		response.body.supportTerminateDebuggee = true;
		response.body.supportSuspendDebuggee = true;

		this.sendResponse(response);
		this.sendEvent(new InitializedEvent());
	}

	/**
	 * Launch request - start debugging session
	 */
	protected async launchRequest(
		response: DebugProtocol.LaunchResponse,
		args: any
	): Promise<void> {
		// Get workspace root
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (workspaceFolders && workspaceFolders.length > 0) {
			this.workspaceRoot = workspaceFolders[0].uri.fsPath;
		}

		const program = args.program as string;
		const stopOnEntry = args.stopOnEntry !== false;
		const trace = args.trace === true;

		// Find debugger executable
		const debuggerPath = this.findDebuggerExecutable();
		if (!debuggerPath) {
			this.sendErrorResponse(
				response,
				1,
				'Could not find SchemaLangDebugger executable. Please build the project first.'
			);
			return;
		}

		try {
			// Launch debugger process
			this.debuggerProcess = spawn(debuggerPath, [], {
				cwd: path.dirname(debuggerPath),
				stdio: ['pipe', 'pipe', 'pipe']
			});

			// Set up output handlers
			this.debuggerProcess.stdout.on('data', (data: Buffer) => {
				this.handleDebuggerOutput(data.toString());
			});

			this.debuggerProcess.stderr.on('data', (data: Buffer) => {
				const msg = data.toString();
				if (trace) {
					this.sendEvent(new OutputEvent(msg, 'stderr'));
				}
			});

			this.debuggerProcess.on('exit', (code) => {
				this.promptResolvers = [];
				this.hasPrompt = false;
				this.sendEvent(new TerminatedEvent());
			});

			this.debuggerProcess.on('error', (err) => {
				this.sendEvent(new OutputEvent(`Debugger error: ${err.message}\n`, 'stderr'));
				this.sendEvent(new TerminatedEvent());
			});

			// Wait for debugger to be ready
			await this.waitForPrompt();

			// Load the schema file
			await this.sendCommand(`run ${program}`);

			this.state.isRunning = true;
			this.state.currentFile = program;

			if (stopOnEntry) {
				// Debugger already stops on entry, just report it
				this.sendEvent(new StoppedEvent('entry', 1));
				this.state.isPaused = true;
			}

			this.sendResponse(response);
		} catch (error) {
			this.sendErrorResponse(
				response,
				2,
				`Failed to launch debugger: ${error}`
			);
		}
	}

	/**
	 * Set breakpoints request
	 */
	protected async setBreakPointsRequest(
		response: DebugProtocol.SetBreakpointsResponse,
		args: DebugProtocol.SetBreakpointsArguments
	): Promise<void> {
		const path = args.source.path!;
		const clientLines = args.breakpoints || [];

		// Clear existing breakpoints for this file
		const existingBps = this.breakpoints.get(path) || [];
		for (const bp of existingBps) {
			await this.sendCommand(`delete ${bp.debuggerId}`);
		}

		// Set new breakpoints
		const newBreakpoints: BreakpointInfo[] = [];
		const actualBreakpoints: DebugProtocol.Breakpoint[] = [];

		for (const clientBp of clientLines) {
			try {
				const location = `${path}:${clientBp.line}`;
				const output = await this.sendCommand(`break line ${location}`);
				
				// Parse breakpoint ID from output (e.g., "Breakpoint 1 set.")
				const match = output.match(/Breakpoint (\d+) set/);
				if (match) {
					const debuggerId = parseInt(match[1]);
					const bpInfo: BreakpointInfo = {
						vscodeId: this.nextBreakpointId++,
						debuggerId,
						type: 'line',
						location,
						verified: true
					};
					newBreakpoints.push(bpInfo);

					actualBreakpoints.push({
						id: bpInfo.vscodeId,
						verified: true,
						line: clientBp.line,
						source: args.source
					});

					// Handle conditions if present
					if (clientBp.condition) {
						// Note: Need to extend debugger to support conditions via command
						// For now, conditions are not supported
					}
				} else {
					// Breakpoint failed
					actualBreakpoints.push({
						id: this.nextBreakpointId++,
						verified: false,
						line: clientBp.line,
						message: 'Failed to set breakpoint'
					});
				}
			} catch (error) {
				actualBreakpoints.push({
					id: this.nextBreakpointId++,
					verified: false,
					line: clientBp.line,
					message: `Error: ${error}`
				});
			}
		}

		this.breakpoints.set(path, newBreakpoints);

		response.body = {
			breakpoints: actualBreakpoints
		};
		this.sendResponse(response);
	}

	/**
	 * Continue request
	 */
	protected async continueRequest(
		response: DebugProtocol.ContinueResponse,
		args: DebugProtocol.ContinueArguments
	): Promise<void> {
		this.astCacheDirty = true;
		await this.sendCommand('continue');
		this.state.isRunning = true;
		this.state.isPaused = false;

		response.body = {
			allThreadsContinued: true
		};
		this.sendResponse(response);
	}

	/**
	 * Next (step over) request
	 */
	protected async nextRequest(
		response: DebugProtocol.NextResponse,
		args: DebugProtocol.NextArguments
	): Promise<void> {
		this.astCacheDirty = true;
		await this.sendCommand('next');
		this.state.isPaused = true;
		this.sendResponse(response);
		this.sendEvent(new StoppedEvent('step', 1));
	}

	/**
	 * Step in request
	 */
	protected async stepInRequest(
		response: DebugProtocol.StepInResponse,
		args: DebugProtocol.StepInArguments
	): Promise<void> {
		this.astCacheDirty = true;
		await this.sendCommand('step');
		this.state.isPaused = true;
		this.sendResponse(response);
		this.sendEvent(new StoppedEvent('step', 1));
	}

	/**
	 * Step out request
	 */
	protected async stepOutRequest(
		response: DebugProtocol.StepOutResponse,
		args: DebugProtocol.StepOutArguments
	): Promise<void> {
		this.astCacheDirty = true;
		await this.sendCommand('parse');
		this.state.isPaused = true;
		this.sendResponse(response);
		this.sendEvent(new StoppedEvent('step', 1));
	}

	/**
	 * Pause request
	 */
	protected pauseRequest(
		response: DebugProtocol.PauseResponse,
		args: DebugProtocol.PauseArguments
	): void {
		// Send interrupt signal to debugger
		if (this.debuggerProcess) {
			this.debuggerProcess.kill('SIGINT');
		}
		this.state.isPaused = true;
		this.sendResponse(response);
		this.sendEvent(new StoppedEvent('pause', 1));
	}

	/**
	 * Stack trace request
	 */
	protected async stackTraceRequest(
		response: DebugProtocol.StackTraceResponse,
		args: DebugProtocol.StackTraceArguments
	): Promise<void> {
		// Get current context
		const contextOutput = await this.sendCommand('context');
		this.parseContextOutput(contextOutput);

		// Get parse stack
		const stackOutput = await this.sendCommand('where');
		const stackFrames = this.parseStackOutput(stackOutput);

		response.body = {
			stackFrames,
			totalFrames: stackFrames.length
		};
		this.sendResponse(response);
	}

	/**
	 * Scopes request
	 */
	protected scopesRequest(
		response: DebugProtocol.ScopesResponse,
		args: DebugProtocol.ScopesArguments
	): void {
		const scopes: DebugProtocol.Scope[] = [
			{
				name: 'Current Context',
				variablesReference: SCOPE_CONTEXT,
				expensive: false
			},
			{
				name: 'Parse Stack',
				variablesReference: SCOPE_PARSE_STACK,
				expensive: false
			},
			{
				name: 'AST (Structs & Enums)',
				variablesReference: SCOPE_AST,
				expensive: true
			}
		];

		response.body = {
			scopes
		};
		this.sendResponse(response);
	}

	/**
	 * Variables request - provides expandable AST tree
	 */
	protected async variablesRequest(
		response: DebugProtocol.VariablesResponse,
		args: DebugProtocol.VariablesArguments
	): Promise<void> {
		const variables: DebugProtocol.Variable[] = [];
		const ref = args.variablesReference;

		if (ref === SCOPE_CONTEXT) {
			// Current Context scope
			variables.push(
				{ name: 'file', value: this.state.currentFile, variablesReference: 0 },
				{ name: 'line', value: String(this.state.currentLine), variablesReference: 0 },
				{ name: 'column', value: String(this.state.currentColumn), variablesReference: 0 },
				{ name: 'token_index', value: String(this.state.tokenIndex), variablesReference: 0 }
			);

			// Get current token
			const tokenOutput = await this.sendCommand('print token');
			const tokenValue = this.parseVariableOutput(tokenOutput);
			variables.push({ name: 'current_token', value: tokenValue, variablesReference: 0 });

			// Get current operation
			const opOutput = await this.sendCommand('print operation');
			const opValue = this.parseVariableOutput(opOutput);
			variables.push({ name: 'operation', value: opValue, variablesReference: 0 });

			// Get counts
			const structCountOutput = await this.sendCommand('print struct_count');
			variables.push({ name: 'struct_count', value: this.parseVariableOutput(structCountOutput), variablesReference: 0 });

			const enumCountOutput = await this.sendCommand('print enum_count');
			variables.push({ name: 'enum_count', value: this.parseVariableOutput(enumCountOutput), variablesReference: 0 });

			const tokenCountOutput = await this.sendCommand('print token_count');
			variables.push({ name: 'token_count', value: this.parseVariableOutput(tokenCountOutput), variablesReference: 0 });

		} else if (ref === SCOPE_PARSE_STACK) {
			// Parse Stack scope
			const stackOutput = await this.sendCommand('where');
			const lines = stackOutput.split('\n');
			for (const line of lines) {
				const match = line.match(/#(\d+)\s+(.+)/);
				if (match) {
					variables.push({
						name: `#${match[1]}`,
						value: match[2].trim(),
						variablesReference: 0
					});
				}
			}

		} else if (ref === SCOPE_AST) {
			// AST root scope - refresh cache if dirty
			await this.refreshASTCache();

			// List structs as expandable
			for (let i = 0; i < this.cachedStructs.length; i++) {
				const s = this.cachedStructs[i];
				const label = s.version ? `${s.name} v${s.version}` : s.name;
				variables.push({
					name: `struct ${s.name}`,
					value: `${label} (${s.memberCount} members)`,
					variablesReference: s.memberCount > 0 ? SCOPE_AST_STRUCTS_BASE + i : 0
				});
			}

			// List enums as expandable
			for (let i = 0; i < this.cachedEnums.length; i++) {
				const e = this.cachedEnums[i];
				variables.push({
					name: `enum ${e.name}`,
					value: `${e.name} (${e.values.length} values)`,
					variablesReference: e.values.length > 0 ? SCOPE_AST_ENUMS_BASE + i : 0
				});
			}

		} else if (ref >= SCOPE_AST_STRUCTS_BASE && ref < SCOPE_AST_ENUMS_BASE) {
			// Struct detail - list member variables
			const structIdx = ref - SCOPE_AST_STRUCTS_BASE;
			if (structIdx >= 0 && structIdx < this.cachedStructs.length) {
				const s = this.cachedStructs[structIdx];
				for (let mi = 0; mi < s.members.length; mi++) {
					const m = s.members[mi];
					const flagsStr = m.flags.length > 0 ? ` [${m.flags.join(', ')}]` : '';
					variables.push({
						name: m.name,
						value: `${m.type}${flagsStr}`,
						variablesReference: SCOPE_AST_MEMBERS_BASE + structIdx * 1000 + mi
					});
				}
			}

		} else if (ref >= SCOPE_AST_ENUMS_BASE && ref < SCOPE_AST_MEMBERS_BASE) {
			// Enum detail - list values
			const enumIdx = ref - SCOPE_AST_ENUMS_BASE;
			if (enumIdx >= 0 && enumIdx < this.cachedEnums.length) {
				const e = this.cachedEnums[enumIdx];
				for (const v of e.values) {
					variables.push({
						name: v.name,
						value: String(v.value),
						variablesReference: 0
					});
				}
			}

		} else if (ref >= SCOPE_AST_MEMBERS_BASE) {
			// Member detail - show all properties
			const memberRef = ref - SCOPE_AST_MEMBERS_BASE;
			const structIdx = Math.floor(memberRef / 1000);
			const memberIdx = memberRef % 1000;
			if (structIdx >= 0 && structIdx < this.cachedStructs.length) {
				const s = this.cachedStructs[structIdx];
				if (memberIdx >= 0 && memberIdx < s.members.length) {
					// Get detailed member info from debugger
					const memberOutput = await this.sendCommand(`print member ${s.name}.${s.members[memberIdx].name}`);
					const lines = memberOutput.split('\n');
					for (const line of lines) {
						const kvMatch = line.match(/^\s+(\w+)\s*=\s*(.+)$/);
						if (kvMatch) {
							variables.push({
								name: kvMatch[1],
								value: kvMatch[2].trim(),
								variablesReference: 0
							});
						}
					}
				}
			}
		}

		response.body = {
			variables
		};
		this.sendResponse(response);
	}

	/**
	 * Evaluate request (for hover, watch, etc.)
	 */
	protected async evaluateRequest(
		response: DebugProtocol.EvaluateResponse,
		args: DebugProtocol.EvaluateArguments
	): Promise<void> {
		try {
			const output = await this.sendCommand(`print ${args.expression}`);
			const value = this.parseVariableOutput(output);

			response.body = {
				result: value,
				variablesReference: 0
			};
			this.sendResponse(response);
		} catch (error) {
			this.sendErrorResponse(response, 3, `Cannot evaluate: ${error}`);
		}
	}

	/**
	 * Threads request
	 */
	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
		// SchemaLang debugger is single-threaded
		response.body = {
			threads: [{ id: 1, name: 'Main Thread' }]
		};
		this.sendResponse(response);
	}

	/**
	 * Disconnect request
	 */
	protected disconnectRequest(
		response: DebugProtocol.DisconnectResponse,
		args: DebugProtocol.DisconnectArguments
	): void {
		if (this.debuggerProcess) {
			this.debuggerProcess.stdin.write('quit\n');
			this.debuggerProcess.kill();
			this.debuggerProcess = null;
		}
		this.promptResolvers = [];
		this.hasPrompt = false;
		this.sendResponse(response);
	}

	/**
	 * Refresh the cached AST data from the debugger
	 */
	private async refreshASTCache(): Promise<void> {
		if (!this.astCacheDirty) return;

		this.cachedStructs = [];
		this.cachedEnums = [];

		// Get AST summary from debugger
		const astOutput = await this.sendCommand('print ast');
		this.parseASTOutput(astOutput);
		this.astCacheDirty = false;
	}

	/**
	 * Parse the AST summary output from "print ast" command
	 */
	private parseASTOutput(output: string): void {
		const lines = output.split('\n');
		let currentStruct: StructInfo | null = null;
		let currentEnum: EnumInfo | null = null;

		for (const line of lines) {
			// Match struct header: "struct Name v1.0.0 (N members)" or "struct Name (N members)"
			const structMatch = line.match(/^struct\s+(\w+)(?:\s+v([\d.]+))?\s+\((\d+)\s+members?\)/);
			if (structMatch) {
				if (currentStruct) this.cachedStructs.push(currentStruct);
				if (currentEnum) { this.cachedEnums.push(currentEnum); currentEnum = null; }
				currentStruct = {
					name: structMatch[1],
					version: structMatch[2] || '',
					memberCount: parseInt(structMatch[3]),
					members: []
				};
				continue;
			}

			// Match member lines inside struct: "  type name [flags]"
			if (currentStruct) {
				const memberMatch = line.match(/^\s+(\S+)\s+(\w+)(.*)/);
				if (memberMatch) {
					const flags: string[] = [];
					const flagStr = memberMatch[3];
					if (flagStr.includes('[PK]')) flags.push('primary_key');
					if (flagStr.includes('[REQ]')) flags.push('required');
					if (flagStr.includes('[UNQ]')) flags.push('unique');
					const refMatch = flagStr.match(/\[REF:(\w+)\]/);
					if (refMatch) flags.push(`reference(${refMatch[1]})`);

					currentStruct.members.push({
						name: memberMatch[2],
						type: memberMatch[1],
						flags
					});
					continue;
				}
			}

			// Match enum header: "enum Name (N values)"
			const enumMatch = line.match(/^enum\s+(\w+)\s+\((\d+)\s+values?\)/);
			if (enumMatch) {
				if (currentStruct) { this.cachedStructs.push(currentStruct); currentStruct = null; }
				if (currentEnum) this.cachedEnums.push(currentEnum);
				currentEnum = {
					name: enumMatch[1],
					values: []
				};
				continue;
			}

			// Match enum value lines: "  Name = N"
			if (currentEnum) {
				const valueMatch = line.match(/^\s+(\w+)\s*=\s*(\d+)/);
				if (valueMatch) {
					currentEnum.values.push({
						name: valueMatch[1],
						value: parseInt(valueMatch[2])
					});
					continue;
				}
			}
		}

		// Push last item
		if (currentStruct) this.cachedStructs.push(currentStruct);
		if (currentEnum) this.cachedEnums.push(currentEnum);
	}

	/**
	 * Send a command to the debugger and wait for response
	 */
	private sendCommand(command: string): Promise<string> {
		return new Promise((resolve, reject) => {
			if (!this.debuggerProcess) {
				reject(new Error('Debugger process not running'));
				return;
			}

			// Queue the command
			this.commandQueue.push({ command, resolve });

			// Process queue if not already processing
			if (!this.currentCommand) {
				this.processNextCommand();
			}
		});
	}

	/**
	 * Process the next command in the queue
	 */
	private processNextCommand(): void {
		if (this.commandQueue.length === 0) {
			this.currentCommand = null;
			return;
		}

		this.currentCommand = this.commandQueue.shift()!;
		this.outputBuffer = '';
		this.hasPrompt = false;
		
		if (this.debuggerProcess) {
			this.debuggerProcess.stdin.write(this.currentCommand.command + '\n');
		}
	}

	/**
	 * Handle output from the debugger process
	 */
	private handleDebuggerOutput(data: string): void {
		this.outputBuffer += data;

		// Check if we have one or more complete responses (end with prompt)
		while (this.outputBuffer.includes('(sldb)')) {
			this.hasPrompt = true;
			if (this.promptResolvers.length > 0) {
				for (const resolver of this.promptResolvers) {
					resolver();
				}
				this.promptResolvers = [];
			}
			const promptIndex = this.outputBuffer.indexOf('(sldb)');
			const output = this.outputBuffer.substring(0, promptIndex);
			if (output.trim().length > 0) {
				this.sendEvent(new OutputEvent(output, 'stdout'));
			}
			
			// Check for breakpoint hit
			if (output.includes('Breakpoint') && output.includes('hit at')) {
				this.state.isPaused = true;
				this.parseBreakpointOutput(output);
				this.sendEvent(new StoppedEvent('breakpoint', 1));
			}

			// Resolve current command
			if (this.currentCommand) {
				this.currentCommand.resolve(output.trim());
				this.currentCommand = null;
				this.processNextCommand();
			}

			// Clear buffer after prompt
			this.outputBuffer = this.outputBuffer.substring(promptIndex + 6);
		}
	}

	/**
	 * Wait for the debugger prompt to appear
	 */
	private waitForPrompt(): Promise<void> {
		if (this.hasPrompt) {
			this.hasPrompt = false;
			return Promise.resolve();
		}

		return new Promise((resolve) => {
			this.promptResolvers.push(() => {
				this.hasPrompt = false;
				resolve();
			});
		});
	}

	/**
	 * Parse context output and update state
	 */
	private parseContextOutput(output: string): void {
		// Parse output like:
		// File: /path/to/file.schema
		// Line: 42, Column: 10
		// Token Index: 15 / 200

		const fileMatch = output.match(/File: (.+)/);
		if (fileMatch) this.state.currentFile = fileMatch[1].trim();

		const lineMatch = output.match(/Line: (\d+)/);
		if (lineMatch) this.state.currentLine = parseInt(lineMatch[1]);

		const colMatch = output.match(/Column: (\d+)/);
		if (colMatch) this.state.currentColumn = parseInt(colMatch[1]);

		const tokenMatch = output.match(/Token Index: (\d+)/);
		if (tokenMatch) this.state.tokenIndex = parseInt(tokenMatch[1]);
	}

	/**
	 * Parse stack output and create stack frames
	 */
	private parseStackOutput(output: string): DebugProtocol.StackFrame[] {
		const frames: DebugProtocol.StackFrame[] = [];
		const lines = output.split('\n');

		// Parse lines like: "  #0 parsing struct: Character"
		for (const line of lines) {
			const match = line.match(/#(\d+)\s+(.+)/);
			if (match) {
				const frameId = parseInt(match[1]);
				const name = match[2].trim();
				
				frames.push({
					id: frameId,
					name,
					source: {
						path: this.state.currentFile
					},
					line: this.state.currentLine,
					column: this.state.currentColumn
				});
			}
		}

		// If no frames found, create a default one
		if (frames.length === 0) {
			frames.push({
				id: 0,
				name: 'main',
				source: {
					path: this.state.currentFile
				},
				line: this.state.currentLine,
				column: this.state.currentColumn
			});
		}

		return frames;
	}

	/**
	 * Parse breakpoint output
	 */
	private parseBreakpointOutput(output: string): void {
		// Parse output like: "Breakpoint 1 hit at file.schema:42"
		const match = output.match(/Breakpoint \d+ hit at (.+):(\d+)/);
		if (match) {
			this.state.currentFile = match[1];
			this.state.currentLine = parseInt(match[2]);
		}
	}

	/**
	 * Parse variable output from print command
	 */
	private parseVariableOutput(output: string): string {
		// Parse output like: "token = 'struct'"
		const match = output.match(/=\s*(.+)/);
		if (match) {
			return match[1].trim();
		}
		return output.trim();
	}

	/**
	 * Find the debugger executable
	 */
	private findDebuggerExecutable(): string | null {
		// Try workspace-relative path first
		const workspacePath = path.join(this.workspaceRoot, 'bin', 'SchemaLangDebugger');
		if (require('fs').existsSync(workspacePath)) {
			return workspacePath;
		}

		// Try parent workspace (for SchemaLang submodule)
		const parentPath = path.join(this.workspaceRoot, '..', 'bin', 'SchemaLangDebugger');
		if (require('fs').existsSync(parentPath)) {
			return parentPath;
		}

		// Try SchemaLang subdirectory
		const schemaLangPath = path.join(this.workspaceRoot, 'SchemaLang', 'bin', 'SchemaLangDebugger');
		if (require('fs').existsSync(schemaLangPath)) {
			return schemaLangPath;
		}

		return null;
	}
}
