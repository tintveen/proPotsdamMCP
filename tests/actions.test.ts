import { describe, expect, it } from "vitest";
import type { PortalService } from "../src/types.js";

describe("portal action discovery", () => {
  const service: PortalService = {
    id: "SRV-1",
    title: "Reparatur",
    serviceUrl: "/repair-service",
    xuclass: "ESQ_TENA_DMG",
    raw: {}
  };

  it("extracts form actions, fields, and non-preparable action-like rows", async () => {
    const { extractPortalActions } = await import("../src/portal/parsers.js");

    const actions = extractPortalActions(`
      <boxlist>
        <box>
          <id>DMG-NEW</id>
          <title>Schaden melden</title>
          <command>submit</command>
          <method>POST</method>
          <endpoint>/repair-service</endpoint>
          <field>
            <name>description</name>
            <label>Beschreibung</label>
            <required>true</required>
            <type>textarea</type>
          </field>
          <field>
            <name>csrfToken</name>
            <value>csrf-secret</value>
            <hidden>true</hidden>
          </field>
        </box>
        <box>
          <id>$BS_READCONFIRMED</id>
          <title>Lesebestätigung angefordert</title>
        </box>
        <box>
          <id>$BS_CALL_LINK</id>
          <title>Extern öffnen</title>
          <url>https://example.test/outside</url>
        </box>
        <box>
          <id>$BS_NAVIGATE</id>
          <title>Weiter</title>
          <command>navigate</command>
        </box>
        <box>
          <id>$BS_UNKNOWN</id>
          <title>Unklare Portalaktion</title>
        </box>
      </boxlist>
    `, "application/xml", service);

    expect(actions).toHaveLength(5);
    expect(actions[0]).toMatchObject({
      id: "DMG-NEW",
      serviceTitle: "Reparatur",
      xuclass: "ESQ_TENA_DMG",
      title: "Schaden melden",
      actionKind: "form",
      method: "POST",
      endpoint: "/repair-service",
      requiresInput: true,
      riskLevel: "medium",
      preparable: true,
      fields: [
        {
          name: "description",
          label: "Beschreibung",
          required: true,
          hidden: false,
          type: "textarea"
        },
        {
          name: "csrfToken",
          value: "csrf-secret",
          hidden: true
        }
      ]
    });
    expect(actions[1]).toMatchObject({
      actionKind: "read_confirmation",
      preparable: false,
      notPreparableReason: "read_confirmation"
    });
    expect(actions[2]).toMatchObject({
      actionKind: "external_link",
      preparable: false,
      notPreparableReason: "external_link"
    });
    expect(actions[3]).toMatchObject({
      actionKind: "navigation",
      preparable: false,
      notPreparableReason: "navigation"
    });
    expect(actions[4]).toMatchObject({
      actionKind: "ambiguous",
      preparable: false,
      notPreparableReason: "ambiguous"
    });
  });

  it("deduplicates actions by service, id, and title", async () => {
    const { extractPortalActions } = await import("../src/portal/parsers.js");

    const actions = extractPortalActions(`
      <boxlist>
        <box><id>A-1</id><title>Anfrage senden</title><command>submit</command><field><name>message</name></field></box>
        <box><id>A-1</id><title>Anfrage senden</title><command>submit</command><field><name>message</name></field></box>
      </boxlist>
    `, "application/xml", service);

    expect(actions).toHaveLength(1);
  });

  it("extracts OPPC detail form actions with current values and locked fields", async () => {
    const { extractPortalActions } = await import("../src/portal/parsers.js");

    const actions = extractPortalActions(`
      <form>
        <id>9F9E6796-A87C-F19A-7860-F942B285D380</id>
        <title>Meine Daten</title>
        <action>
          <id>save_partner</id>
          <name>save_partner</name>
          <text>Speichern</text>
          <method>POST</method>
        </action>
        <field>
          <id>SO_#NAME_FIRST#_I_CP</id>
          <name>name_first_ref</name>
          <label>Vorname*</label>
          <value>Tillmann</value>
          <required>true</required>
          <editable>true</editable>
        </field>
        <field>
          <id>SO_#PHONE#_I_CP</id>
          <name>phone_ref</name>
          <label>Telefon*</label>
          <value>+15550100000</value>
          <required>true</required>
          <editable>true</editable>
        </field>
        <field>
          <id>SO_#SMTP_ADDR#_I_CP</id>
          <name>mail</name>
          <label>E-Mail*</label>
          <value>user@example.test</value>
          <required>true</required>
          <editable>false</editable>
          <hint>Bitte im Profilmenü andern.</hint>
        </field>
        <choicefield id="SO_#TITLE#_I_CP" meta:saved_value="0002" refname="int_anrede" required="true">
          <choice id="0001" title="Frau"/>
          <choice id="0002" selected="true" title="Herr"/>
        </choicefield>
        <field>
          <id>ESQ_CHANGED</id>
          <type>hidden</type>
          <value>true</value>
        </field>
      </form>
    `, "application/xml", {
      serviceId: "A85F0DC3-999F-A915-AD7B-FE6A39BB98C5",
      serviceTitle: "Meine Daten",
      serviceUrl: "/prorex/xmlforms?application=ESQ_IA_PART&sap-client=511",
      xuclass: "ESQ_IA_PART"
    }, {
      source: "detail",
      recordId: "9F9E6796-A87C-F19A-7860-F942B285D380",
      recordTitle: "Meine Daten"
    });

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      id: "save_partner",
      title: "Speichern",
      source: "detail",
      recordId: "9F9E6796-A87C-F19A-7860-F942B285D380",
      recordTitle: "Meine Daten",
      serviceTitle: "Meine Daten",
      xuclass: "ESQ_IA_PART",
      actionKind: "form",
      preparable: true,
      fields: expect.arrayContaining([
        expect.objectContaining({
          name: "name_first_ref",
          portalId: "SO_#NAME_FIRST#_I_CP",
          label: "Vorname*",
          value: "Tillmann",
          required: true,
          editable: true
        }),
        expect.objectContaining({
          name: "mail",
          portalId: "SO_#SMTP_ADDR#_I_CP",
          value: "user@example.test",
          editable: false
        }),
        expect.objectContaining({
          name: "int_anrede",
          portalId: "SO_#TITLE#_I_CP",
          value: "0002",
          required: true,
          editable: true,
          options: [
            { value: "0001", label: "Frau", selected: false },
            { value: "0002", label: "Herr", selected: true }
          ]
        }),
        expect.objectContaining({
          name: "ESQ_CHANGED",
          hidden: true,
          value: "true"
        })
      ])
    });
  });

  it("extracts OPPC upload fields only as supported when an upload endpoint is exposed", async () => {
    const { extractPortalActions } = await import("../src/portal/parsers.js");

    const actions = extractPortalActions(`
      <form id="REPAIR-FORM">
        <title>Schaden melden</title>
        <action>
          <id>cmdsend</id>
          <name>cmdsend</name>
          <text>Schaden melden</text>
          <method>POST</method>
        </action>
        <textarea id="msg_txt" refname="msg_txt" required="true" title="Beschreibung*"></textarea>
        <filefield id="ATTACH_PHOTO" refname="damage_photo" title="Foto" uploadUrl="/repair-upload" accept="image/jpeg,image/png"/>
        <uploadfield id="ATTACH_OTHER" refname="other_attachment" title="Weitere Anlage"/>
      </form>
    `, "application/xml", service, {
      source: "detail",
      recordId: "REPAIR-FORM",
      recordTitle: "Schaden melden"
    });

    expect(actions).toHaveLength(1);
    expect(actions[0]?.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "damage_photo",
        portalId: "ATTACH_PHOTO",
        type: "file",
        upload: {
          supported: true,
          mode: "multipart_form_data",
          endpoint: "/repair-upload",
          acceptMimeTypes: ["image/jpeg", "image/png"]
        }
      }),
      expect.objectContaining({
        name: "other_attachment",
        upload: expect.objectContaining({
          supported: false,
          reason: "Upload field does not expose an upload endpoint."
        })
      })
    ]));
  });
});
