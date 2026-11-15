const automaticRedactions: [RegExp, string][] = [
  [/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|$)/g, "[REDACTED PRIVATE KEY]"],
  [/\b(?:sk-[A-Za-z0-9_-]{16,}|(?:sk|rk)_(?:test|live)_[A-Za-z0-9_+=/-]{16,}|AIza[A-Za-z0-9_-]{35}|tdsync_[0-9a-f]{64}|(?:github_pat_|gh[pousr]_|xox[baprs]-)[A-Za-z0-9_-]{16,}|(?:AKIA|ASIA)[0-9A-Z]{16})\b/g, "[REDACTED TOKEN]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED TOKEN]"],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/-]{12,}={0,2}/gi, "$1 [REDACTED]"],
  [/(\bAuthorization\s*[:=]\s*Basic\s+)[A-Za-z0-9+/]{12,}={0,2}/gi, "$1[REDACTED]"],
  [/(\b(?:[A-Z0-9_]*(?:TOKEN|SECRET|API_KEY|PASSWORD)|password)\s*[:=]\s*)(?:"[^"\r\n]+"|'[^'\r\n]+'|[^\s,;]+)/gi, "$1[REDACTED]"],
  [/(https?:\/\/[^\s:/@]+:)[^\s/@]+(?=@)/gi, "$1[REDACTED]"],
];

export function redactConversationText(text: string) {
  return automaticRedactions.reduce((result, [pattern, replacement]) => result.replace(pattern, replacement), text);
}

export function redactCaptureText(text: string) {
  return redactConversationText(text)
    .replace(/("(?:authorization|cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|token|password|private[_-]?key)"\s*:\s*)"[^"\r\n]*"/giu, '$1"[REDACTED]"')
    .replace(/((?:^|\n)[+\- ]*(?:export\s+)?(?:DATABASE_URL|DB_URL|NEON_DB_URL)\s*=)[^\r\n]+/giu, "$1[REDACTED]")
    .replace(/(\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s:/@]+:)[^\s/@]+(?=@)/giu, "$1[REDACTED]")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/[\x00\uD800-\uDFFF]/gu, "\uFFFD");
}

export function privateRecordKey(key: string) {
  return /^(?:auth|authorization|proxyauthorization|cookie|setcookie|(?:access|api|auth|bearer|refresh|session|id)?token|apikey|clientsecret|credential(?:s)?|(?:db|database)?password|privatekey|secret|env|environment)$/u.test(key.toLowerCase().replace(/[^a-z0-9]/gu, ""));
}
