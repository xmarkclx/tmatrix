import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

export function environmentPath(environment: Record<string, string>): string[] {
  const key = Object.keys(environment).find(key => key.toUpperCase() === "PATH");
  return (key ? environment[key] ?? "" : "").split(delimiter).filter(isAbsolute);
}

export function hostExecutableCandidates(
  environment: Record<string, string>, executable: string, override: string | undefined, extraPath?: string
): string[] {
  if (override) return isAbsolute(override) ? [override] : [];

  const path = environmentPath(environment);
  const home = environment.HOME || environment.USERPROFILE || homedir();
  return [...new Set([
    ...path.map(directory => join(directory, executable)),
    ...(isAbsolute(home) ? [join(home, ".local", "bin", executable)] : []),
    ...(extraPath ? path.map(directory => join(directory, extraPath)) : [])
  ])];
}
