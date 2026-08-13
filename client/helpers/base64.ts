const decodeBytes = (value: string): Uint8Array => {
  const binary = window.atob(value)
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}

export const decodeBase64Text = (value: string): string => new TextDecoder().decode(decodeBytes(value))

export const decodeBase64Json = <T>(value: string): T => JSON.parse(decodeBase64Text(value)) as T
