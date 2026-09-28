export type UserPicture = { kind: 'image'; url: string } | { kind: 'initials'; initials: string }

export function resolveUserPicture(user: { id: number; name: string; pictureUrl: string }): UserPicture {
  const pictureUrl = typeof user.pictureUrl === 'string' ? user.pictureUrl : ''
  if (pictureUrl.length > 1) {
    return { kind: 'image', url: pictureUrl === 'internal' ? `/_userav/${user.id}` : pictureUrl }
  }
  const name = typeof user.name === 'string' ? user.name : ''
  const nameParts = name.toUpperCase().split(' ').filter(Boolean)
  let initials = nameParts[0]?.charAt(0) ?? ''
  if (nameParts.length > 1) initials += nameParts[nameParts.length - 1]?.charAt(0) ?? ''
  return { kind: 'initials', initials }
}
