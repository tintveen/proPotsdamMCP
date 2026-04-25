export function encodeSapFfieldBase64(values: Record<string, string>, includeEmpty = false): string {
  const parts: string[] = [];
  for (const [key, rawValue] of Object.entries(values)) {
    if (!rawValue && !includeEmpty && key !== "titletx") {
      continue;
    }
    const value = rawValue.replace(/%/g, encodeURIComponent("%")).replace(/&/g, encodeURIComponent("&")).replace(/\+/g, encodeURIComponent("+"));
    parts.push(`${key}=${value}`);
  }
  return Buffer.from(parts.join("&"), "utf8").toString("base64");
}

export function formEncodeSapFfield(values: Record<string, string>): URLSearchParams {
  const body = new URLSearchParams();
  body.set("sap-ffield_b64", encodeSapFfieldBase64(values));
  return body;
}
