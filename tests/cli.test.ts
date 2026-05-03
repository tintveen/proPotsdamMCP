import { describe, expect, it, vi } from "vitest";
import type { AuthResult } from "../src/types.js";

describe("CLI", () => {
  it("prints help with a zero exit code", async () => {
    const { runCli } = await import("../src/cli.js");
    let stdout = "";

    const exitCode = await runCli(
      ["node", "propotsdam-mcp", "--help"],
      {
        write: (text: string) => {
          stdout += text;
        },
        question: async () => {
          throw new Error("question should not be called");
        },
        questionHidden: async () => {
          throw new Error("questionHidden should not be called");
        }
      },
      {
        discoverCapabilities: async () => {
          throw new Error("discoverCapabilities should not be called");
        },
        discoverWriteActions: async () => {
          throw new Error("discoverWriteActions should not be called");
        }
      }
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain("propotsdam-mcp serve");
    expect(stdout).toContain("propotsdam-mcp auth set");
    expect(stdout).toContain("propotsdam-mcp auth status");
    expect(stdout).toContain("propotsdam-mcp auth login");
    expect(stdout).toContain("propotsdam-mcp auth logout");
    expect(stdout).toContain("propotsdam-mcp doctor");
  });

  it.each([
    {
      argv: ["node", "propotsdam-mcp", "auth", "status"],
      method: "status" as const,
      result: {
        state: "authenticated" as const,
        authenticated: true,
        userId: "user-id"
      }
    },
    {
      argv: ["node", "propotsdam-mcp", "auth", "login"],
      method: "login" as const,
      result: {
        state: "authenticated" as const,
        authenticated: true,
        userFullName: "Fixture User"
      }
    },
    {
      argv: ["node", "propotsdam-mcp", "auth", "logout"],
      method: "logout" as const,
      result: {
        ok: true as const
      }
    }
  ])("prints auth $method results as JSON without prompting or discovery", async ({ argv, method, result }) => {
    const { runCli } = await import("../src/cli.js");
    const calls: string[] = [];
    let stdout = "";

    const exitCode = await runCli(
      argv,
      {
        write: (text: string) => {
          stdout += text;
        },
        question: async () => {
          throw new Error("question should not be called");
        },
        questionHidden: async () => {
          throw new Error("questionHidden should not be called");
        }
      },
      {
        status: async () => {
          calls.push("status");
          return method === "status" ? result as AuthResult : {
            state: "unauthenticated",
            authenticated: false
          };
        },
        login: async () => {
          calls.push("login");
          return method === "login" ? result as AuthResult : {
            state: "unauthenticated",
            authenticated: false
          };
        },
        logout: async () => {
          calls.push("logout");
          return { ok: true };
        },
        discoverCapabilities: async () => {
          throw new Error("discoverCapabilities should not be called");
        },
        discoverWriteActions: async () => {
          throw new Error("discoverWriteActions should not be called");
        }
      }
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual(result);
    expect(calls).toEqual([method]);
  });

  it("prints doctor reports as JSON without prompting or discovering portal data", async () => {
    const { runCli } = await import("../src/cli.js");
    let stdout = "";

    const exitCode = await runCli(
      ["node", "propotsdam-mcp", "doctor"],
      {
        write: (text: string) => {
          stdout += text;
        },
        question: async () => {
          throw new Error("question should not be called");
        },
        questionHidden: async () => {
          throw new Error("questionHidden should not be called");
        }
      },
      {
        discoverCapabilities: async () => {
          throw new Error("discoverCapabilities should not be called");
        },
        discoverWriteActions: async () => {
          throw new Error("discoverWriteActions should not be called");
        }
      },
      {
        loadConfig: async () => ({
          baseUrl: "https://portal.example.test",
          apiVersion: "6.262",
          appVersion: "6.262.8",
          language: "de",
          exportDir: "/tmp/exports",
          clientId: "client-id"
        }),
        configureCredentials: vi.fn(),
        configFile: "/tmp/propotsdam-mcp/config.json",
        createDoctorReport: async () => ({
          generatedAt: "2026-05-03T00:00:00.000Z",
          runtime: {
            nodeVersion: "22.1.0",
            nodeSupported: true,
            platform: "darwin",
            arch: "arm64",
            command: "propotsdam-mcp"
          },
          paths: {
            dataDir: "/tmp/propotsdam-mcp",
            configFile: "/tmp/propotsdam-mcp/config.json",
            tracesDir: "/tmp/propotsdam-mcp/traces",
            exportsDir: "/tmp/propotsdam-mcp/exports",
            confirmationsDir: "/tmp/propotsdam-mcp/confirmations"
          },
          config: {
            baseUrl: "https://portal.example.test",
            apiVersion: "6.262",
            appVersion: "6.262.8",
            language: "de",
            usernameConfigured: false,
            usernameSource: "none"
          },
          credentials: {
            passwordConfigured: false,
            passwordSource: "none"
          },
          session: {
            checked: true,
            authenticated: false,
            state: "unauthenticated"
          },
          portalReachability: {
            checked: true,
            reachable: true,
            method: "HEAD",
            status: 200,
            url: "https://portal.example.test"
          }
        })
      }
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      runtime: {
        nodeSupported: true
      },
      credentials: {
        passwordConfigured: false
      },
      portalReachability: {
        reachable: true
      }
    });
  });

  it("prints discover capability maps as JSON", async () => {
    const previousExitCode = process.exitCode;
    const { runCli } = await import("../src/cli.js");
    process.exitCode = previousExitCode;
    let stdout = "";

    await runCli(
      ["node", "propotsdam-mcp", "discover", "--json"],
      {
        write: (text: string) => {
          stdout += text;
        },
        question: async () => {
          throw new Error("question should not be called");
        },
        questionHidden: async () => {
          throw new Error("questionHidden should not be called");
        }
      },
      {
        discoverCapabilities: async () => ({
          generatedAt: "2026-04-25T00:00:00.000Z",
          authenticated: true,
          dataPolicy: "ProPotsdam exposes readable portal data only.",
          services: [],
          totals: {
            serviceCount: 0,
            inboxItems: 0,
            portalRecords: 0,
            unknownItems: 0
          },
          artifactPath: "/tmp/capabilities.json"
        }),
        discoverWriteActions: async () => {
          throw new Error("discoverWriteActions should not be called");
        }
      }
    );

    expect(JSON.parse(stdout)).toMatchObject({
      authenticated: true,
      artifactPath: "/tmp/capabilities.json"
    });
  });

  it("prints write action maps as JSON", async () => {
    const { runCli } = await import("../src/cli.js");
    let stdout = "";

    await runCli(
      ["node", "propotsdam-mcp", "actions", "--json"],
      {
        write: (text: string) => {
          stdout += text;
        },
        question: async () => {
          throw new Error("question should not be called");
        },
        questionHidden: async () => {
          throw new Error("questionHidden should not be called");
        }
      },
      {
        discoverCapabilities: async () => {
          throw new Error("discoverCapabilities should not be called");
        },
        discoverWriteActions: async () => ({
          generatedAt: "2026-04-25T00:00:00.000Z",
          authenticated: true,
          actionPolicy: "Prepare-only. No request is sent to ProPotsdam.",
          services: [
            {
              serviceId: "SRV-1",
              title: "Reparatur",
              xuclass: "ESQ_TENA_DMG",
              actionCount: 1,
              preparableActions: 1,
              skippedActions: 0,
              actionIds: ["A-1"]
            }
          ],
          actions: [
            {
              id: "A-1",
              serviceId: "SRV-1",
              serviceTitle: "Reparatur",
              xuclass: "ESQ_TENA_DMG",
              title: "Schaden melden",
              source: "boxlist",
              actionKind: "form",
              method: "POST",
              endpoint: "/repair-service",
              fields: [],
              requiresInput: false,
              riskLevel: "medium",
              preparable: true,
              rawHints: {}
            }
          ],
          totals: {
            serviceCount: 1,
            actionCount: 1,
            preparableActions: 1,
            skippedActions: 0
          },
          partial: false,
          detailScanLimit: 250,
          artifactPath: "/tmp/actions.json"
        })
      }
    );

    expect(JSON.parse(stdout)).toMatchObject({
      authenticated: true,
      artifactPath: "/tmp/actions.json",
      totals: {
        actionCount: 1
      }
    });
  });

  it("auth set prompts only for username and password by default", async () => {
    const { runCli } = await import("../src/cli.js");
    const prompts: string[] = [];
    const saved: unknown[] = [];
    let stdout = "";

    const exitCode = await runCli(
      ["node", "propotsdam-mcp", "auth", "set"],
      {
        write: (text: string) => {
          stdout += text;
        },
        question: async (prompt: string) => {
          prompts.push(prompt);
          return "user@example.test";
        },
        questionHidden: async (prompt: string) => {
          prompts.push(prompt);
          return "super-secret";
        }
      },
      undefined,
      {
        loadConfig: async () => ({
          baseUrl: "https://propotsdam-kundenportal.easysquare.com",
          apiVersion: "6.262",
          appVersion: "6.262.8",
          language: "de",
          exportDir: "/tmp/exports",
          clientId: "client-id"
        }),
        configureCredentials: async (options: unknown) => {
          saved.push(options);
        },
        configFile: "/tmp/propotsdam-mcp/config.json"
      }
    );

    expect(exitCode).toBe(0);
    expect(prompts).toEqual(["Username: ", "Password: "]);
    expect(saved).toEqual([
      {
        username: "user@example.test",
        password: "super-secret",
        baseUrl: "https://propotsdam-kundenportal.easysquare.com"
      }
    ]);
    expect(stdout).toContain("Credentials stored");
    expect(stdout).toContain("/tmp/propotsdam-mcp/config.json");
  });

  it("auth set accepts an explicit --base-url override", async () => {
    const { runCli } = await import("../src/cli.js");
    const saved: unknown[] = [];

    await runCli(
      ["node", "propotsdam-mcp", "auth", "set", "--base-url", "https://portal.example.test"],
      {
        write: () => undefined,
        question: async () => "user@example.test",
        questionHidden: async () => "super-secret"
      },
      undefined,
      {
        loadConfig: async () => ({
          baseUrl: "https://propotsdam-kundenportal.easysquare.com",
          apiVersion: "6.262",
          appVersion: "6.262.8",
          language: "de",
          exportDir: "/tmp/exports",
          clientId: "client-id"
        }),
        configureCredentials: async (options: unknown) => {
          saved.push(options);
        },
        configFile: "/tmp/propotsdam-mcp/config.json"
      }
    );

    expect(saved).toEqual([
      {
        username: "user@example.test",
        password: "super-secret",
        baseUrl: "https://portal.example.test"
      }
    ]);
  });

  it("auth set repairs a corrupted baseUrl before saving", async () => {
    const { runCli } = await import("../src/cli.js");
    const { DEFAULT_BASE_URL } = await import("../src/constants.js");
    const saved: unknown[] = [];

    await runCli(
      ["node", "propotsdam-mcp", "auth", "set"],
      {
        write: () => undefined,
        question: async () => "user@example.test",
        questionHidden: async () => "super-secret"
      },
      undefined,
      {
        loadConfig: async () => ({
          baseUrl: "user@example.test",
          apiVersion: "6.262",
          appVersion: "6.262.8",
          language: "de",
          exportDir: "/tmp/exports",
          clientId: "client-id"
        }),
        configureCredentials: async (options: unknown) => {
          saved.push(options);
        },
        configFile: "/tmp/propotsdam-mcp/config.json"
      }
    );

    expect(saved).toEqual([
      {
        username: "user@example.test",
        password: "super-secret",
        baseUrl: DEFAULT_BASE_URL
      }
    ]);
  });


  it("renders CLI errors without a stack trace", async () => {
    const { runCli } = await import("../src/cli.js");
    let stderr = "";

    const exitCode = await runCli(
      ["node", "propotsdam-mcp", "auth", "set"],
      {
        write: (text: string) => {
          stderr += text;
        },
        question: async () => "",
        questionHidden: async () => "unused"
      },
      undefined,
      {
        loadConfig: async () => ({
          baseUrl: "https://propotsdam-kundenportal.easysquare.com",
          apiVersion: "6.262",
          appVersion: "6.262.8",
          language: "de",
          exportDir: "/tmp/exports",
          clientId: "client-id"
        }),
        configureCredentials: vi.fn(),
        configFile: "/tmp/propotsdam-mcp/config.json"
      }
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Username is required.");
    expect(stderr).not.toContain("at ");
  });
});
