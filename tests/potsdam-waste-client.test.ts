import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  POTSDAM_WASTE_CREATE_URL,
  POTSDAM_WASTE_GEOCODER_ORIGIN,
  PotsdamWasteClient,
  semanticPotsdamWasteFingerprint,
  stagePotsdamWastePhoto,
  verifyStagedPotsdamWastePhoto
} from "../src/potsdam/index.js";

const fixtureDirectory = new URL("./fixtures/redacted/potsdam/", import.meta.url);
const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

describe("PotsdamWasteClient", () => {
  it("inspects the current Next configuration and feature-specific upload rules", async () => {
    const mock = await createMockFetch();
    const client = new PotsdamWasteClient(mock.fetchImpl);

    const config = await client.inspectConfig();

    expect(config).toMatchObject({
      sourceUrl: "https://mitgestalten.potsdam.de/de/maengel-melden/create?step=2",
      moduleId: 3,
      category: { id: 1, name: "Abfall" },
      bounds: { west: 12.509, south: 52.215, east: 13.381, north: 52.635 },
      maxDescriptionChars: 500,
      geocoderUuid: "9fbc768b-0b78-6901-e600-867c2cfa13d6",
      photoRules: {
        required: true,
        maxCount: 3,
        maxInputBytes: 8 * 1024 * 1024,
        maxInputPixels: 50_000_000,
        maxOutputBytes: 8 * 1024 * 1024,
        maxOutputLongEdge: 4096,
        acceptedInputMimeTypes: ["image/png", "image/jpeg", "image/gif", "image/webp"],
        outputMimeType: "image/jpeg",
        outputJpegQuality: 85
      }
    });
    expect(config.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(mock.requests.every((request) => request.init?.credentials === "omit")).toBe(true);
    expect(mock.requests.every((request) => request.init?.redirect === "manual")).toBe(true);
  });

  it("requires a unique in-bounds forward-geocoder result", async () => {
    const mock = await createMockFetch({
      geocoderFeatures: [feature("address-1", 13.0592, 52.3906, "Lindenstraße 1, 14467 Potsdam")]
    });
    const client = new PotsdamWasteClient(mock.fetchImpl);
    const config = await client.inspectConfig();

    await expect(client.geocodeAddress("Lindenstraße 1 Potsdam", config)).resolves.toEqual({
      latitude: 52.3906,
      longitude: 13.0592,
      displayAddress: "Lindenstraße 1, 14467 Potsdam",
      featureId: "address-1",
      source: "address"
    });

    const geocoderRequest = mock.requests.find((request) => request.url.origin === POTSDAM_WASTE_GEOCODER_ORIGIN);
    expect(geocoderRequest?.url.pathname).toBe(
      "/gdz_geokodierung__9fbc768b-0b78-6901-e600-867c2cfa13d6/geosearch"
    );
    expect(geocoderRequest?.url.searchParams.get("query")).toBe("Lindenstraße 1 Potsdam");
    expect(geocoderRequest?.url.searchParams.get("bbox")).toBe("12.509,52.215,13.381,52.635");
  });

  it("fingerprints semantic constraints independent of MIME-list order", async () => {
    const mock = await createMockFetch();
    const config = await new PotsdamWasteClient(mock.fetchImpl).inspectConfig();
    const reordered = {
      ...config,
      photoRules: {
        ...config.photoRules,
        acceptedInputMimeTypes: [...config.photoRules.acceptedInputMimeTypes].reverse()
      }
    };

    expect(semanticPotsdamWasteFingerprint(reordered)).toBe(config.fingerprint);
    expect(semanticPotsdamWasteFingerprint({
      ...reordered,
      category: { id: 99, name: "Abfall" }
    })).not.toBe(config.fingerprint);
  });

  it("rejects ambiguous or out-of-bounds address results", async () => {
    const ambiguous = await createMockFetch({
      geocoderFeatures: [
        feature("one", 13.05, 52.39, "Beispielweg 1, Potsdam"),
        feature("two", 13.06, 52.4, "Beispielweg 2, Potsdam")
      ]
    });
    const ambiguousClient = new PotsdamWasteClient(ambiguous.fetchImpl);
    const ambiguousConfig = await ambiguousClient.inspectConfig();
    await expect(ambiguousClient.geocodeAddress("Beispielweg Potsdam", ambiguousConfig)).rejects.toMatchObject({
      code: "ADDRESS_AMBIGUOUS"
    });

    const outside = await createMockFetch({
      geocoderFeatures: [feature("berlin", 13.405, 52.52, "Berlin")]
    });
    const outsideClient = new PotsdamWasteClient(outside.fetchImpl);
    const outsideConfig = await outsideClient.inspectConfig();
    await expect(outsideClient.geocodeAddress("Alexanderplatz Berlin", outsideConfig)).rejects.toMatchObject({
      code: "LOCATION_OUT_OF_BOUNDS"
    });
  });

  it("accepts explicit in-bounds coordinates without depending on reverse geocoding", async () => {
    const mock = await createMockFetch({
      geocoderFeatures: [feature("nearby", 13.05921, 52.39061, "Lindenstraße 1, 14467 Potsdam")]
    });
    const client = new PotsdamWasteClient(mock.fetchImpl);
    const config = await client.inspectConfig();

    const preview = await client.previewCoordinates({ latitude: 52.3906, longitude: 13.0592 }, config);

    expect(preview).toMatchObject({
      latitude: 52.3906,
      longitude: 13.0592,
      displayAddress: "52.390600, 13.059200",
      source: "coordinates"
    });
    expect(mock.requests.some((entry) => entry.url.origin === POTSDAM_WASTE_GEOCODER_ORIGIN)).toBe(false);
  });

  it("re-inspects then performs one multipart commit with no auth or privacy field", async () => {
    const directory = await temporaryDirectory();
    const inputPath = path.join(directory, "source.png");
    await sharp({
      create: { width: 96, height: 64, channels: 4, background: { r: 20, g: 120, b: 220, alpha: 0.5 } }
    }).png().toFile(inputPath);
    const photo = await stagePotsdamWastePhoto(inputPath, path.join(directory, "staged"));
    const mock = await createMockFetch({ createBody: { id: "redacted-report-id" } });
    const client = new PotsdamWasteClient(mock.fetchImpl);
    const config = await client.inspectConfig();

    const result = await client.commit({
      location: { latitude: 52.3906, longitude: 13.0592 },
      description: "  Illegal abgelegter Schrank neben den Mülltonnen.  ",
      reporterEmail: "reporter@example.test",
      reporterFirstName: "Ada",
      reporterLastName: "Beispiel",
      privacyConsent: true
    }, [photo], config.fingerprint);

    expect(result).toEqual({
      ok: true,
      state: "awaiting_email_confirmation",
      httpStatus: 200,
      reportId: "redacted-report-id",
      summary: expect.stringContaining("email confirmation")
    });
    const createRequests = mock.requests.filter((request) => request.url.toString() === POTSDAM_WASTE_CREATE_URL);
    expect(createRequests).toHaveLength(1);
    const create = createRequests[0]!;
    expect(create.init?.method).toBe("POST");
    expect(create.init?.credentials).toBe("omit");
    expect(create.init?.redirect).toBe("manual");
    const headers = new Headers(create.init?.headers);
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("content-type")).toBeNull();
    expect(headers.get("x-language")).toBe("de");
    expect(create.init?.body).toBeInstanceOf(FormData);
    const form = create.init?.body as FormData;
    const stringFields: Record<string, string> = {};
    form.forEach((value, key) => {
      if (typeof value === "string") {
        stringFields[key] = value;
      }
    });
    expect(stringFields).toEqual({
      flawReporterId: "3",
      latitude: "52.3906",
      longitude: "13.0592",
      categoryId: "1",
      text: "Illegal abgelegter Schrank neben den Mülltonnen.",
      reporterEmail: "reporter@example.test",
      reporterFirstname: "Ada",
      reporterName: "Beispiel"
    });
    expect(form.has("privacyConsent")).toBe(false);
    const upload = form.get("pictures[0]");
    expect(upload).toBeInstanceOf(Blob);
    expect((upload as Blob).type).toBe("image/jpeg");
    expect((upload as Blob & { name?: string }).name).toBe(photo.filename);
  });

  it("refuses a stale semantic fingerprint before any create POST", async () => {
    const mock = await createMockFetch();
    const client = new PotsdamWasteClient(mock.fetchImpl);

    await expect(client.commit({
      location: { latitude: 52.3906, longitude: 13.0592 },
      description: "Abgelagerter Sperrmüll",
      reporterEmail: "reporter@example.test",
      privacyConsent: true
    }, [], "sha256:stale")).rejects.toMatchObject({ code: "CONFIG_CHANGED" });
    expect(mock.requests.filter((request) => request.url.toString() === POTSDAM_WASTE_CREATE_URL)).toHaveLength(0);
  });

  it("maps the portal's documented error codes", async () => {
    const directory = await temporaryDirectory();
    const inputPath = path.join(directory, "source.jpg");
    await sharp({ create: { width: 32, height: 32, channels: 3, background: "orange" } }).jpeg().toFile(inputPath);
    const photo = await stagePotsdamWastePhoto(inputPath, path.join(directory, "staged"));
    const mock = await createMockFetch({
      createStatus: 400,
      createBody: { apiErrorCode: "flaw-reporter-error-001" }
    });
    const client = new PotsdamWasteClient(mock.fetchImpl);
    const config = await client.inspectConfig();

    await expect(client.commit(validDraft(), [photo], config.fingerprint)).rejects.toMatchObject({
      code: "MAX_REPORTS_REACHED",
      status: 400
    });
  });

  it("marks an unrecognized successful create response as an uncertain outcome", async () => {
    const directory = await temporaryDirectory();
    const inputPath = path.join(directory, "source.jpg");
    await sharp({ create: { width: 32, height: 32, channels: 3, background: "orange" } }).jpeg().toFile(inputPath);
    const photo = await stagePotsdamWastePhoto(inputPath, path.join(directory, "staged"));
    const mock = await createMockFetch({ createRawBody: "not-json" });
    const client = new PotsdamWasteClient(mock.fetchImpl);
    const config = await client.inspectConfig();

    await expect(client.commit(validDraft(), [photo], config.fingerprint)).rejects.toMatchObject({
      code: "AMBIGUOUS_WRITE",
      message: expect.stringContaining("Do not retry automatically"),
      status: 200
    });
    expect(mock.requests.filter((request) => request.url.toString() === POTSDAM_WASTE_CREATE_URL)).toHaveLength(1);
  });

  it("fails closed on valid JSON that does not match the known create receipt", async () => {
    const directory = await temporaryDirectory();
    const inputPath = path.join(directory, "source.jpg");
    await sharp({ create: { width: 32, height: 32, channels: 3, background: "orange" } }).jpeg().toFile(inputPath);
    const photo = await stagePotsdamWastePhoto(inputPath, path.join(directory, "staged"));
    const mock = await createMockFetch({ createBody: {} });
    const client = new PotsdamWasteClient(mock.fetchImpl);
    const config = await client.inspectConfig();

    await expect(client.commit(validDraft(), [photo], config.fingerprint)).rejects.toMatchObject({
      code: "AMBIGUOUS_WRITE",
      status: 200
    });
    expect(mock.requests.filter((request) => request.url.toString() === POTSDAM_WASTE_CREATE_URL)).toHaveLength(1);
  });

  it("marks a final transport failure as uncertain without leaking the underlying error", async () => {
    const directory = await temporaryDirectory();
    const inputPath = path.join(directory, "source.jpg");
    await sharp({ create: { width: 32, height: 32, channels: 3, background: "orange" } }).jpeg().toFile(inputPath);
    const photo = await stagePotsdamWastePhoto(inputPath, path.join(directory, "staged"));
    const sensitive = "Musterweg 10 token=secret /private/reporter.jpg";
    const mock = await createMockFetch({ createError: new Error(sensitive) });
    const client = new PotsdamWasteClient(mock.fetchImpl);
    const config = await client.inspectConfig();

    let caught: unknown;
    try {
      await client.commit(validDraft(), [photo], config.fingerprint);
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      code: "AMBIGUOUS_WRITE",
      message: expect.stringContaining("Do not retry automatically")
    });
    expect(String(caught)).not.toContain("Musterweg");
    expect(String(caught)).not.toContain("secret");
    expect(String(caught)).not.toContain("/private");
    expect(mock.requests.filter((request) => request.url.toString() === POTSDAM_WASTE_CREATE_URL)).toHaveLength(1);
  });

  it("refuses redirects from pinned origins", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: "https://attacker.example/" }
    })) as unknown as typeof fetch;

    await expect(new PotsdamWasteClient(fetchImpl).inspectConfig()).rejects.toMatchObject({
      code: "UNSAFE_REDIRECT"
    });
  });
});

describe("Potsdam waste photo normalization", () => {
  it("auto-orients, bounds, flattens, strips metadata, and verifies the persisted artifact", async () => {
    const directory = await temporaryDirectory();
    const inputPath = path.join(directory, "camera.png");
    await sharp({
      create: { width: 5000, height: 1200, channels: 4, background: { r: 180, g: 40, b: 80, alpha: 0.4 } }
    })
      .png()
      .withMetadata({ orientation: 6 })
      .toFile(inputPath);

    const staged = await stagePotsdamWastePhoto(inputPath, path.join(directory, "stage"));
    const verified = await verifyStagedPotsdamWastePhoto(staged);
    const metadata = await sharp(staged.path).metadata();

    expect(staged).toMatchObject({
      mimeType: "image/jpeg",
      filename: expect.stringMatching(/^potsdam-waste-[0-9a-f-]+\.jpg$/),
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/)
    });
    expect(Math.max(staged.width, staged.height)).toBeLessThanOrEqual(4096);
    expect(staged.byteLength).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(verified.bytes.byteLength).toBe(staged.byteLength);
    expect(metadata).toMatchObject({ format: "jpeg", width: staged.width, height: staged.height });
    expect(metadata.exif).toBeUndefined();
    expect(metadata.icc).toBeUndefined();
    expect(metadata.xmp).toBeUndefined();
    expect(metadata.orientation).toBeUndefined();
  });

  it("rejects symlinks and formats requiring an explicit conversion", async () => {
    const directory = await temporaryDirectory();
    const targetPath = path.join(directory, "target.png");
    const linkPath = path.join(directory, "link.png");
    await sharp({ create: { width: 8, height: 8, channels: 3, background: "red" } }).png().toFile(targetPath);
    await symlink(targetPath, linkPath);

    await expect(stagePotsdamWastePhoto(linkPath, path.join(directory, "stage"))).rejects.toMatchObject({
      code: "PHOTO_INVALID"
    });

    const animatedWebpPath = path.join(directory, "animated.webp");
    await writeFile(animatedWebpPath, syntheticAnimatedWebp());
    await expect(stagePotsdamWastePhoto(animatedWebpPath, path.join(directory, "stage"))).rejects.toMatchObject({
      code: "PHOTO_CONVERSION_REQUIRED",
      message: expect.stringContaining("Convert the image")
    });

    const gifPath = path.join(directory, "image.gif");
    await writeFile(gifPath, Buffer.from("GIF89a redacted synthetic body"));
    await expect(stagePotsdamWastePhoto(gifPath, path.join(directory, "stage"))).rejects.toMatchObject({
      code: "PHOTO_CONVERSION_REQUIRED"
    });

    const heicPath = path.join(directory, "camera.heic");
    const heic = Buffer.alloc(24);
    heic.writeUInt32BE(24, 0);
    heic.write("ftyp", 4, "ascii");
    heic.write("heic", 8, "ascii");
    await writeFile(heicPath, heic);
    await expect(stagePotsdamWastePhoto(heicPath, path.join(directory, "stage"))).rejects.toMatchObject({
      code: "PHOTO_CONVERSION_REQUIRED",
      message: expect.stringContaining("HEIC")
    });
  });

  it("detects a changed staged artifact before submission", async () => {
    const directory = await temporaryDirectory();
    const inputPath = path.join(directory, "source.png");
    await sharp({ create: { width: 24, height: 24, channels: 3, background: "green" } }).png().toFile(inputPath);
    const staged = await stagePotsdamWastePhoto(inputPath, path.join(directory, "stage"));
    const original = await readFile(staged.path);
    original[original.length - 1] = original[original.length - 1]! ^ 0xff;
    await writeFile(staged.path, original);

    await expect(verifyStagedPotsdamWastePhoto(staged)).rejects.toMatchObject({ code: "PHOTO_CHANGED" });
  });
});

interface MockFetchOptions {
  geocoderFeatures?: unknown[];
  createStatus?: number;
  createBody?: unknown;
  createRawBody?: string;
  createError?: Error;
}

interface MockRequest {
  url: URL;
  init?: RequestInit;
}

async function createMockFetch(options: MockFetchOptions = {}) {
  const page = await readFile(new URL("create-page.html", fixtureDirectory), "utf8");
  const chunk = await readFile(new URL("flaw-wizard.js", fixtureDirectory), "utf8");
  const requests: MockRequest[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests.push({ url, init });
    if (url.origin === "https://mitgestalten.potsdam.de" && url.pathname === "/de/maengel-melden/create") {
      return textResponse(page, 200, "text/html");
    }
    if (url.origin === "https://mitgestalten.potsdam.de" && url.pathname.endsWith("/flaw-wizard.js")) {
      return textResponse(chunk, 200, "application/javascript");
    }
    if (url.origin === "https://mitgestalten.potsdam.de" && url.pathname.endsWith("/common.js")) {
      return textResponse("/* unrelated */", 200, "application/javascript");
    }
    if (url.origin === POTSDAM_WASTE_GEOCODER_ORIGIN) {
      return jsonResponse({ type: "FeatureCollection", features: options.geocoderFeatures ?? [] });
    }
    if (url.toString() === POTSDAM_WASTE_CREATE_URL) {
      if (options.createError) {
        throw options.createError;
      }
      if (options.createRawBody !== undefined) {
        return textResponse(options.createRawBody, options.createStatus ?? 200, "text/plain");
      }
      return jsonResponse(options.createBody ?? {}, options.createStatus ?? 200);
    }
    throw new Error(`Unexpected network request in test: ${url}`);
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}

function feature(id: string, longitude: number, latitude: number, text: string) {
  return {
    id,
    type: "Feature",
    geometry: { type: "Point", coordinates: [longitude, latitude] },
    properties: { text }
  };
}

function textResponse(body: string, status = 200, contentType = "text/plain"): Response {
  return new Response(body, { status, headers: { "content-type": contentType } });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "potsdam-waste-test-"));
  tempDirectories.push(directory);
  return directory;
}

function validDraft() {
  return {
    location: { latitude: 52.3906, longitude: 13.0592 },
    description: "Abgelagerter Sperrmüll",
    reporterEmail: "reporter@example.test",
    privacyConsent: true
  };
}

function syntheticAnimatedWebp(): Buffer {
  const bytes = Buffer.alloc(32);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(24, 4);
  bytes.write("WEBP", 8, "ascii");
  bytes.write("VP8X", 12, "ascii");
  bytes.write("ANIM", 24, "ascii");
  return bytes;
}
