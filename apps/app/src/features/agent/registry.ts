/**
 * The command table the MCP tools dispatch into.
 *
 * A command is the renderer half of one MCP tool: it receives already-validated
 * params (zod ran in main, in `electron/mcp/tools/*`) and returns a plain,
 * JSON-serialisable value. Keeping validation in main and execution here means
 * neither side has to import the other's tree — see `electron/mcp/bridge.ts`
 * for why that separation is load-bearing rather than stylistic.
 *
 * Commands must return *small* values. `serialize.ts` exists to enforce that;
 * anything that reaches for `useTimelineStore.getState().timeline` directly and
 * hands it back will blow through Claude Code's 25k-token tool output cap on a
 * project of any size, because a single animated element carries up to 36,000
 * baked samples per lane.
 */

export type AgentCommand = (params: any) => unknown | Promise<unknown>;

const commands = new Map<string, AgentCommand>();

export function registerCommand(name: string, fn: AgentCommand) {
  if (commands.has(name)) {
    throw new Error(`Agent command "${name}" is already registered`);
  }
  commands.set(name, fn);
}

export function registerCommands(table: Record<string, AgentCommand>) {
  for (const [name, fn] of Object.entries(table)) {
    registerCommand(name, fn);
  }
}

export function getCommand(name: string): AgentCommand | undefined {
  return commands.get(name);
}

export function commandNames(): string[] {
  return [...commands.keys()].sort();
}
