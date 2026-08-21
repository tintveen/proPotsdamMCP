import { describe, expect, it } from "vitest";
import type { PortalAction, StructuredPortalRecord } from "../src/types.js";
import {
  parseGermanAddress,
  PortalClientWasteDefaultsProvider,
  type PortalDefaultsClient
} from "../src/waste/portal-defaults.js";

describe("PortalClientWasteDefaultsProvider", () => {
  it("resolves a unique high-confidence contract and profile defaults", async () => {
    const provider = new PortalClientWasteDefaultsProvider(mockClient({
      records: [contractRecord("CONTRACT-1", "Musterweg 10, 14467 Potsdam")],
      fullName: "Erika Muster",
      actions: [profileAction()]
    }));

    await expect(provider.resolve()).resolves.toMatchObject({
      contractId: "CONTRACT-1",
      contact: {
        salutation: "female",
        firstName: "Erika",
        lastName: "Muster",
        email: "erika@example.test",
        phone: "+49331123456",
        address: {
          street: "Musterweg",
          houseNumber: "10",
          postalCode: "14467",
          city: "Potsdam"
        }
      },
      validationIssues: []
    });
  });

  it("requires contractId when multiple complete addresses exist", async () => {
    const provider = new PortalClientWasteDefaultsProvider(mockClient({
      records: [
        contractRecord("CONTRACT-1", "Musterweg 10, 14467 Potsdam"),
        contractRecord("CONTRACT-2", "Beispielallee 2, 14469 Potsdam")
      ]
    }));

    const ambiguous = await provider.resolve();
    expect(ambiguous.validationIssues).toContain("Multiple high-confidence portal contract addresses are available. Provide contractId to choose one.");
    expect(ambiguous.candidates).toHaveLength(2);

    const selected = await provider.resolve("CONTRACT-2");
    expect(selected.contact.address).toMatchObject({ street: "Beispielallee", houseNumber: "2" });
    expect(selected.validationIssues).toEqual([]);
  });

  it("does not guess an incomplete or low-confidence address", async () => {
    const incomplete = contractRecord("CONTRACT-1", "Musterweg 10");
    const low = { ...contractRecord("CONTRACT-2", "Beispielallee 2, 14469 Potsdam"), confidence: "low" as const };
    const provider = new PortalClientWasteDefaultsProvider(mockClient({ records: [incomplete, low] }));

    const result = await provider.resolve();
    expect(result.contact.address).toBeUndefined();
    expect(result.candidates).toEqual([]);
  });

  it("requires an explicit override for conflicting portal profile fields", async () => {
    const first = profileAction();
    const second = {
      ...profileAction(),
      id: "save_partner_duplicate",
      title: "Profil",
      fields: profileAction().fields.map((field) => field.name === "mail"
        ? { ...field, value: "andere@example.test" }
        : field)
    };
    const provider = new PortalClientWasteDefaultsProvider(mockClient({
      records: [contractRecord("CONTRACT-1", "Musterweg 10, 14467 Potsdam")],
      actions: [first, second]
    }));

    const result = await provider.resolve("CONTRACT-1");

    expect(result.contact.email).toBeUndefined();
    expect(result.validationIssues).toContain(
      "Multiple portal profile values were found for contact.email. Provide an explicit override."
    );
  });

  it("lets portal reads establish a session before checking status", async () => {
    let readCompleted = false;
    const provider = new PortalClientWasteDefaultsProvider({
      async listStructuredPortalRecords() {
        readCompleted = true;
        return { items: [contractRecord("CONTRACT-1", "Musterweg 10, 14467 Potsdam")], source: "boxlist" };
      },
      async listPortalActions() {
        return { items: [], source: "boxlist" };
      },
      async status() {
        return readCompleted
          ? { state: "authenticated", authenticated: true }
          : { state: "unauthenticated", authenticated: false };
      }
    });

    const result = await provider.resolve();
    expect(result.contractId).toBe("CONTRACT-1");
    expect(result.validationIssues).toEqual([]);
  });
});

describe("parseGermanAddress", () => {
  it("parses comma and label variants", () => {
    expect(parseGermanAddress("Adresse: Straße des 17. Juni 10-12, 14467 Potsdam")).toEqual({
      street: "Straße des 17. Juni",
      houseNumber: "10-12",
      postalCode: "14467",
      city: "Potsdam"
    });
  });
});

function mockClient(options: {
  records?: StructuredPortalRecord[];
  actions?: PortalAction[];
  fullName?: string;
}): PortalDefaultsClient {
  return {
    async status() {
      return { state: "authenticated", authenticated: true, userFullName: options.fullName };
    },
    async listStructuredPortalRecords() {
      return { items: options.records ?? [], source: "boxlist" };
    },
    async listPortalActions() {
      return { items: options.actions ?? [], source: "boxlist" };
    }
  };
}

function contractRecord(serviceId: string, address: string): StructuredPortalRecord {
  return {
    id: `${serviceId}-RECORD`,
    title: "Mietvertrag",
    sourceRecordId: `${serviceId}-RECORD`,
    sourceRecordTitle: "Mietvertrag",
    serviceId,
    serviceTitle: "Verträge",
    xuclass: "ESQ_TENANT",
    domain: "contract",
    confidence: "high",
    itemKind: "record",
    readable: true,
    address,
    fields: { address }
  };
}

function profileAction(): PortalAction {
  return {
    id: "save_partner",
    serviceTitle: "Meine Daten",
    title: "Meine Daten speichern",
    source: "detail",
    actionKind: "form",
    method: "POST",
    fields: [
      { name: "mail", required: true, hidden: false, editable: false, value: "erika@example.test" },
      { name: "phone_ref", required: false, hidden: false, editable: true, value: "+49331123456" },
      {
        name: "int_anrede",
        required: true,
        hidden: false,
        editable: true,
        value: "0001",
        options: [
          { value: "0001", label: "Frau", selected: true },
          { value: "0002", label: "Herr" }
        ]
      }
    ],
    requiresInput: true,
    riskLevel: "medium",
    preparable: true,
    rawHints: {}
  };
}
