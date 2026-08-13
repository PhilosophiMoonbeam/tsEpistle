import { asError, wiki, type AuthenticationPlugin } from '../../types.ts'

// ------------------------------------
// GitHub Account
// ------------------------------------

import passportGithub2Module from 'passport-github2'
import type { StrategyOptions } from 'passport-github2'
const GitHubStrategy = passportGithub2Module.Strategy
import _ from 'lodash'

const plugin: AuthenticationPlugin = {
  init (passport, conf) {
    const githubConfig: StrategyOptions = {
      clientID: conf.clientId,
      clientSecret: conf.clientSecret,
      callbackURL: conf.callbackURL,
      scope: ['user:email'],
      passReqToCallback: true
    }

    if (conf.useEnterprise) {
      githubConfig.authorizationURL = `https://${conf.enterpriseDomain}/login/oauth/authorize`
      githubConfig.tokenURL = `https://${conf.enterpriseDomain}/login/oauth/access_token`
      githubConfig.userProfileURL = conf.enterpriseUserEndpoint
      githubConfig.userEmailURL = `${conf.enterpriseUserEndpoint}/emails`
    }

    passport.use(conf.key,
      new GitHubStrategy(githubConfig, async (req, accessToken, refreshToken, profile, cb) => {
        try {
          wiki.logger.info(`GitHub OAuth: Processing profile for user ${profile.id || profile.username}`)

          // Ensure email is available - passport-github2 should fetch it automatically with user:email scope
          // but we'll log a warning if it's missing
          if (!profile.emails || (Array.isArray(profile.emails) && profile.emails.length === 0)) {
            wiki.logger.warn(`GitHub OAuth: No email found in profile for user ${profile.id || profile.username}. Make sure 'user:email' scope is granted.`)
          }

          const user = await wiki.models.users.processProfile({
            providerKey: req.params.strategy,
            profile: {
              ...profile,
              picture: _.get(profile, 'photos[0].value', '')
            }
          })

          wiki.logger.info(`GitHub OAuth: Successfully authenticated user ${user.email}`)
          cb(null, user)
        } catch (err: unknown) {
          const error = asError(err)
          wiki.logger.warn(`GitHub OAuth: Authentication failed for strategy ${req.params.strategy}:`, err)
          // Provide more user-friendly error messages
          if (error.message.includes('email')) {
            cb(new Error('GitHub authentication failed: Email address is required but not available. Please ensure your GitHub account has a verified email address and grant email access permissions.'), null)
          } else if (err instanceof wiki.Error.AuthAccountBanned) {
            cb(asError(err), null)
          } else {
            cb(new Error(`GitHub authentication failed: ${error.message || 'Unknown error'}`), null)
          }
        }
      }
      ))
  }
}

export default plugin
