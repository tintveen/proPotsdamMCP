import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  SwpClient,
  type ResolvedSwpDraft,
  type SwpClientErrorCode
} from "../src/swp/index.js";

const LANDING_HTML = fixture("landing.html");
const FORM_HTML = fixture("form.html");
const SUCCESS_HTML = fixture("success.html");
const VALIDATION_ERROR_HTML = fixture("validation-error.html");

interface Reply {
  body: string;
  status?: number;
  headers?: HeadersInit;
}

interface RecordedRequest {
  url: string;
  method: string;
  headers: Headers;
  body: string;
  redirect?: RequestRedirect;
}

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/redacted/swp/${name}`, import.meta.url), "utf8");
}

function createFetch(replies: readonly Reply[]) {
  const requests: RecordedRequest[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: String(init?.body ?? ""),
      redirect: init?.redirect
    });
    const reply = replies[requests.length - 1];
    if (!reply) {
      throw new Error("Unexpected test request");
    }
    return new Response(reply.body, {
      status: reply.status ?? 200,
      headers: reply.headers
    });
  });
  return {
    fetchImpl: fetchMock as unknown as typeof fetch,
    requests,
    fetchMock
  };
}

function landingReply(cookie = "swp_session=landing; Path=/; Secure; HttpOnly"): Reply {
  return {
    body: LANDING_HTML,
    headers: { "set-cookie": cookie }
  };
}

function formReply(): Reply {
  return { body: FORM_HTML };
}

function resolvedDraft(overrides: Partial<ResolvedSwpDraft> = {}): ResolvedSwpDraft {
  return {
    contact: {
      salutation: "mrs",
      surname: "Beispiel",
      firstName: "Erika",
      address: {
        street: "Musterstraße",
        houseNumber: "12 a",
        postalCode: "14467",
        city: "Potsdam"
      },
      email: "erika@example.test",
      phone: "0331 000000",
      customerReference: "TEST-123"
    },
    items: [{ kind: "couch_sofa_bed", quantity: 1 }],
    earliestPickupDate: "2026-08-18",
    placement: "Vor dem Müllplatz",
    message: "Nur Testdaten",
    ...overrides
  };
}

function finalRequests(requests: readonly RecordedRequest[]): RecordedRequest[] {
  return requests.filter((request) => new URLSearchParams(request.body).get("_finish") === "1");
}

async function expectCode(promise: Promise<unknown>, code: SwpClientErrorCode): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

describe("SwpClient", () => {
  it("inspects the semantic form through only GET and read-equivalent bootstrap POST", async () => {
    const { fetchImpl, requests } = createFetch([landingReply(), formReply()]);

    const contract = await new SwpClient(fetchImpl).inspect();

    expect(contract).toMatchObject({
      sourceUrl: "https://www.swp-potsdam.de/de/entsorgung/sperrm%C3%BCllabholung/",
      formId: "commandDE77137",
      constraints: {
        alternatePickupAddressRequiresCompleteAddress: true,
        earliestPickupDateIsNotAnAppointment: true,
        smallElectricalRequiresLargeAppliance: true,
        otherSmallElectricalRequiresFridgeOrWasher: true
      }
    });
    expect(contract.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(contract.fields).toHaveLength(38);
    expect(contract.requiredFields).toHaveLength(12);
    expect(contract.fields.find((field) => field.name === "anrede")?.options?.map((option) => option.value)).toEqual([
      "VALUE_EMPTY",
      "MISS",
      "MISTER",
      "Keine Angabe"
    ]);
    expect(contract.supportedItemKinds).toContain("couch_sofa_bed");
    expect(JSON.stringify(contract)).not.toContain("REDACTED_FORM_DEFINITION");
    expect(JSON.stringify(contract)).not.toContain("REDACTED_TOKEN");

    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      url: "https://www.swp-potsdam.de/de/entsorgung/sperrm%C3%BCllabholung/",
      method: "GET",
      redirect: "manual"
    });
    expect(requests[0]?.headers.has("cookie")).toBe(false);
    expect(requests[1]).toMatchObject({
      url: "https://www.swp-potsdam.de/servlet/form",
      method: "POST",
      redirect: "manual"
    });
    expect(requests[1]?.headers.get("cookie")).toBe("swp_session=landing");
    const bootstrap = new URLSearchParams(requests[1]?.body);
    expect(bootstrap.get("_fd")).toBe("REDACTED_FORM_DEFINITION");
    expect(bootstrap.get("_reset")).toBe("true");
    expect(bootstrap.has("_finish")).toBe(false);
    expect(finalRequests(requests)).toHaveLength(0);
  });

  it("encodes the normalized draft and commits exactly once in a fresh cookie jar", async () => {
    const { fetchImpl, requests } = createFetch([
      landingReply("swp_session=inspection; Path=/; Secure; HttpOnly"),
      formReply(),
      landingReply("swp_session=commit; Path=/; Secure; HttpOnly"),
      formReply(),
      { body: SUCCESS_HTML }
    ]);
    const client = new SwpClient(fetchImpl);
    const contract = await client.inspect();

    const result = await client.commit(resolvedDraft({
      pickupAddress: {
        street: "Abholweg",
        houseNumber: "7",
        postalCode: "14469",
        city: "Potsdam"
      },
      items: [
        { kind: "couch_sofa_bed", quantity: 2 },
        { kind: "floor_covering", areaSquareMetres: 3.5 },
        { kind: "other_bulky", description: "Kinderwagen", quantity: 1 },
        { kind: "fridge_freezer", quantity: 1 },
        { kind: "tv_monitor", quantity: 1 },
        { kind: "other_small_electrical", description: "Toaster", quantity: 2 }
      ]
    }), contract.fingerprint);

    expect(result).toEqual({
      ok: true,
      status: "submitted",
      httpStatus: 200,
      fingerprint: contract.fingerprint,
      summary: "STEP received the bulky-waste pickup request. The pickup date may be communicated separately."
    });
    expect(requests).toHaveLength(5);
    expect(requests[2]?.headers.has("cookie")).toBe(false);
    expect(requests[3]?.headers.get("cookie")).toBe("swp_session=commit");
    expect(requests[4]?.headers.get("cookie")).toBe("swp_session=commit");
    expect(finalRequests(requests)).toHaveLength(1);

    const final = finalRequests(requests)[0]!;
    expect(final.method).toBe("POST");
    expect(final.url).toBe(
      "https://www.swp-potsdam.de/servlet/form?_uid=DE77137&_lang=de_DE&_view=webform&_mwfToken%3ADE77137=REDACTED_TOKEN"
    );
    expect(final.redirect).toBe("manual");
    const body = new URLSearchParams(final.body);
    expect(body.get("_finish")).toBe("1");
    expect(body.get("_parentUrl")).toBe("https://www.swp-potsdam.de/de/entsorgung/sperrm%C3%BCllabholung/");
    expect(body.get("anrede")).toBe("MISS");
    expect(body.get("name")).toBe("Beispiel");
    expect(body.get("alternative_adresse")).toBe("alternativ_adresse");
    expect(body.get("strasse2")).toBe("Abholweg");
    expect(body.get("couch")).toBe("2");
    expect(body.get("teppich")).toBe("3,5");
    expect(body.get("sonstiges")).toBe("1 x Kinderwagen");
    expect(body.get("elektroauswahl")).toBe("elektroschrott");
    expect(body.get("kuehlschrank")).toBe("1");
    expect(body.get("Bildschirme")).toBe("1");
    expect(body.get("sonstiges_elektro")).toBe("2 x Toaster");
    expect(body.get("abholtermin")).toBe("18.08.2026");
  });

  it("detects semantic form drift before making a final request", async () => {
    const driftedForm = FORM_HTML.replace('name="mail" type="email"', 'name="mail" type="text"');
    const { fetchImpl, requests } = createFetch([
      landingReply(),
      formReply(),
      landingReply(),
      { body: driftedForm }
    ]);
    const client = new SwpClient(fetchImpl);
    const contract = await client.inspect();

    await expectCode(client.commit(resolvedDraft(), contract.fingerprint), "FORM_DRIFT");

    expect(requests).toHaveLength(4);
    expect(finalRequests(requests)).toHaveLength(0);
  });

  it("blocks redirects without following them", async () => {
    const { fetchImpl, requests } = createFetch([{
      body: "redirect",
      status: 302,
      headers: { location: "https://example.test/collect" }
    }]);

    await expectCode(new SwpClient(fetchImpl).inspect(), "REDIRECT_BLOCKED");

    expect(requests).toHaveLength(1);
    expect(requests[0]?.redirect).toBe("manual");
  });

  it("rejects a form-configured target outside the pinned HTTPS origin", async () => {
    const foreignTargetForm = FORM_HTML.replace(
      'url: "/servlet/form?',
      'url: "https://example.test/servlet/form?'
    );
    const { fetchImpl, requests } = createFetch([landingReply(), { body: foreignTargetForm }]);

    await expectCode(new SwpClient(fetchImpl).inspect(), "ORIGIN_BLOCKED");

    expect(requests).toHaveLength(2);
    expect(finalRequests(requests)).toHaveLength(0);
  });

  it("enforces the observed other-small-electrical form rule before making a final request", async () => {
    const { fetchImpl, requests } = createFetch([
      landingReply(),
      formReply(),
      landingReply(),
      formReply()
    ]);
    const client = new SwpClient(fetchImpl);
    const contract = await client.inspect();

    await expectCode(client.commit(resolvedDraft({
      items: [
        { kind: "dishwasher", quantity: 1 },
        { kind: "other_small_electrical", description: "Toaster", quantity: 1 }
      ]
    }), contract.fingerprint), "INVALID_DRAFT");

    expect(requests).toHaveLength(4);
    expect(finalRequests(requests)).toHaveLength(0);
  });

  it("does not over-restrict the named vacuum or over-50-centimetre fields", async () => {
    const { fetchImpl, requests } = createFetch([
      landingReply(),
      formReply(),
      landingReply(),
      formReply(),
      { body: SUCCESS_HTML }
    ]);
    const client = new SwpClient(fetchImpl);
    const contract = await client.inspect();

    await expect(client.commit(resolvedDraft({
      items: [
        { kind: "vacuum_cleaner", quantity: 1 },
        { kind: "electrical_over_50cm", description: "Standlampe", quantity: 1 }
      ]
    }), contract.fingerprint)).resolves.toMatchObject({ ok: true });

    expect(finalRequests(requests)).toHaveLength(1);
    const body = new URLSearchParams(finalRequests(requests)[0]?.body);
    expect(body.get("Staubsauger")).toBe("1");
    expect(body.get("Kante_50")).toBe("1 x Standlampe");
  });

  it("reports a validation response after exactly one final request", async () => {
    const { fetchImpl, requests } = createFetch([
      landingReply(),
      formReply(),
      landingReply(),
      formReply(),
      { body: VALIDATION_ERROR_HTML }
    ]);
    const client = new SwpClient(fetchImpl);
    const contract = await client.inspect();

    await expectCode(client.commit(resolvedDraft(), contract.fingerprint), "VALIDATION_FAILED");

    expect(finalRequests(requests)).toHaveLength(1);
  });

  it("requires the known success marker after the final request", async () => {
    const { fetchImpl, requests } = createFetch([
      landingReply(),
      formReply(),
      landingReply(),
      formReply(),
      { body: "<html><body>Danke</body></html>" }
    ]);
    const client = new SwpClient(fetchImpl);
    const contract = await client.inspect();

    await expectCode(client.commit(resolvedDraft(), contract.fingerprint), "AMBIGUOUS_WRITE");

    expect(finalRequests(requests)).toHaveLength(1);
  });

  it("marks a final transport failure as uncertain and never retries it", async () => {
    const { fetchImpl, requests } = createFetch([
      landingReply(),
      formReply(),
      landingReply(),
      formReply()
    ]);
    const client = new SwpClient(fetchImpl);
    const contract = await client.inspect();

    await expect(client.commit(resolvedDraft(), contract.fingerprint)).rejects.toMatchObject({
      code: "AMBIGUOUS_WRITE",
      message: expect.stringContaining("Do not retry automatically")
    });

    expect(finalRequests(requests)).toHaveLength(1);
  });

  it("reports HTTP failures without exposing the response body", async () => {
    const { fetchImpl, requests } = createFetch([{
      body: "sensitive upstream diagnostic",
      status: 503
    }]);
    const client = new SwpClient(fetchImpl);
    let caught: unknown;

    try {
      await client.inspect();
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ code: "HTTP_ERROR", status: 503 });
    expect(String(caught)).not.toContain("sensitive upstream diagnostic");
    expect(requests).toHaveLength(1);
  });
});
