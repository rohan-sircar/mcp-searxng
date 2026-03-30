/**
 * Mock Server Helper
 *
 * Creates mock MCP server objects for testing
 */

export interface MockServer {
  sendLoggingMessage: (params: any) => Promise<void>;
  _serverInfo: { name: string; version: string };
  _capabilities: Record<string, any>;
  connect?: (transport: any) => Promise<void>;
}

/**
 * Create a minimal mock server for testing
 */
export function createMockServer(overrides?: Partial<MockServer>): MockServer {
  const mockLoggingCalls: any[] = [];

  return {
    sendLoggingMessage: async (params: any) => {
      mockLoggingCalls.push(params);
    },
    _serverInfo: { name: 'test', version: '1.0' },
    _capabilities: {},
    connect: async () => Promise.resolve(),
    ...overrides
  };
}

/**
 * Create a mock server that tracks logging calls
 */
export function createMockServerWithTracking(): {
  server: MockServer;
  getLoggingCalls: () => any[];
} {
  const mockLoggingCalls: any[] = [];

  const server: MockServer = {
    sendLoggingMessage: async (params: any) => {
      mockLoggingCalls.push(params);
    },
    _serverInfo: { name: 'test', version: '1.0' },
    _capabilities: {},
    connect: async () => Promise.resolve(),
  };

  return {
    server,
    getLoggingCalls: () => mockLoggingCalls
  };
}
