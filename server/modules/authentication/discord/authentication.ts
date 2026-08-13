import { asError, wiki, type AuthenticationPlugin } from '../../types.ts'

// ------------------------------------
// Discord Account
// ------------------------------------

import {
  DiscordScope,
  Strategy as DiscordStrategy
} from 'discord-strategy'

const plugin: AuthenticationPlugin = {
  init (passport, conf) {
    passport.use(conf.key,
      new DiscordStrategy({
        clientID: conf.clientId,
        clientSecret: conf.clientSecret,
        authorizationURL: 'https://discord.com/api/oauth2/authorize?prompt=none',
        callbackURL: conf.callbackURL,
        scope: [
          DiscordScope.Identify,
          DiscordScope.Email,
          DiscordScope.Guilds
        ],
        passReqToCallback: true
      }, async (req, _accessToken, _refreshToken, _results, profile, cb, consume) => {
        try {
          await consume.guilds()
          if (conf.guildId && !profile.guilds?.some(guild => guild.id === conf.guildId)) {
            throw new wiki.Error.AuthLoginFailed()
          }
          const user = await wiki.models.users.processProfile({
            providerKey: req.params.strategy,
            profile: {
              ...profile,
              displayName: profile.username,
              picture: `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png`
            }
          })
          cb(null, user)
        } catch (err: unknown) {
          cb(asError(err), null)
        }
      }
      ))
  }
}

export default plugin
