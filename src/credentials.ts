import { KEYCHAIN_SERVICE } from "./constants.js";

export interface CredentialStore {
  getPassword(account: string): Promise<string | null>;
  setPassword(account: string, password: string): Promise<void>;
  deletePassword(account: string): Promise<boolean>;
}

export class KeytarCredentialStore implements CredentialStore {
  async getPassword(account: string): Promise<string | null> {
    const keytar = await import("keytar");
    return keytar.getPassword(KEYCHAIN_SERVICE, account);
  }

  async setPassword(account: string, password: string): Promise<void> {
    const keytar = await import("keytar");
    await keytar.setPassword(KEYCHAIN_SERVICE, account, password);
  }

  async deletePassword(account: string): Promise<boolean> {
    const keytar = await import("keytar");
    return keytar.deletePassword(KEYCHAIN_SERVICE, account);
  }
}
