import { describe, expect, it, vi } from "vitest";

describe("CLI", () => {
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
          services: [],
          totals: {
            services: 0,
            inboxItems: 0,
            documentItems: 0,
            downloadableDocuments: 0,
            genericRecords: 0,
            safeDownloadCandidates: 0,
            skippedDownloadCandidates: 0,
            unknownItems: 0
          },
          safety: {
            maxDocumentsBeforeConfirmation: 100,
            maxDownloadBytesBeforeConfirmation: 1_000_000_000,
            needsConfirmation: false
          },
          artifactPath: "/tmp/capabilities.json"
        })
      }
    );

    expect(JSON.parse(stdout)).toMatchObject({
      authenticated: true,
      artifactPath: "/tmp/capabilities.json"
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
          return "info@tintveen.com";
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
          downloadDir: "/tmp/downloads",
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
        username: "info@tintveen.com",
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
        question: async () => "info@tintveen.com",
        questionHidden: async () => "super-secret"
      },
      undefined,
      {
        loadConfig: async () => ({
          baseUrl: "https://propotsdam-kundenportal.easysquare.com",
          apiVersion: "6.262",
          appVersion: "6.262.8",
          language: "de",
          downloadDir: "/tmp/downloads",
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
        username: "info@tintveen.com",
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
        question: async () => "info@tintveen.com",
        questionHidden: async () => "super-secret"
      },
      undefined,
      {
        loadConfig: async () => ({
          baseUrl: "info@tintveen.com",
          apiVersion: "6.262",
          appVersion: "6.262.8",
          language: "de",
          downloadDir: "/tmp/downloads",
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
        username: "info@tintveen.com",
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
          downloadDir: "/tmp/downloads",
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
