import express from 'express'
import { objectValue } from '../_types.ts'

import contributeOperations from '../../operations/contribute.ts'

const router = express.Router()

const optionalString = (value: unknown): unknown => typeof value === 'undefined' ? null : value

router.get('/contributors', async (req, res) => {
  const contributors = await contributeOperations.listContributors()
  res.json(contributors.map(contributor => ({
    id: objectValue(contributor, 'id'),
    source: objectValue(contributor, 'source'),
    name: objectValue(contributor, 'name'),
    joined: objectValue(contributor, 'joined'),
    website: optionalString(objectValue(contributor, 'website')),
    twitter: optionalString(objectValue(contributor, 'twitter')),
    avatar: optionalString(objectValue(contributor, 'avatar'))
  })))
})

export default router
