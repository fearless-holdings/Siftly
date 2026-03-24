/**
 * Category proposal and reconciliation - allows the AI to suggest new categories
 * during categorization when no existing category is a clean fit.
 */

import prisma from '@/lib/db'

export interface CategoryProposal {
  name: string
  slug?: string
  description: string
  tweetIds: string[]
  confidence: number
}

export interface CategorizationWithProposals {
  tweetId: string
  assignments: Array<{
    category: string
    confidence: number
  }>
  proposals?: CategoryProposal[]
}

/**
 * Generate a deterministic slug from a category name
 */
export function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\w\s-]/g, '') // Remove special chars
    .replace(/\s+/g, '-') // Space to dash
    .replace(/-+/g, '-') // Collapse dashes
    .slice(0, 50) // Max length
}

/**
 * Generate a deterministic color for a category
 */
const COLORS = [
  '#8b5cf6', '#f59e0b', '#06b6d4', '#10b981', '#f97316',
  '#6366f1', '#ec4899', '#14b8a6', '#ef4444', '#3b82f6',
  '#a855f7', '#eab308', '#f43f5e', '#14b8a6', '#7c3aed',
]

export function generateColor(slug: string): string {
  let hash = 0
  for (let i = 0; i < slug.length; i++) {
    hash = ((hash << 5) - hash) + slug.charCodeAt(i)
    hash = hash & hash // Convert to 32-bit integer
  }
  return COLORS[Math.abs(hash) % COLORS.length]
}

/**
 * Find the closest existing category to a proposal using semantic similarity
 */
export async function findClosestCategory(
  proposal: CategoryProposal,
): Promise<{ slug: string; similarity: number } | null> {
  const existing = await prisma.category.findMany({
    select: { slug: true, name: true, description: true },
  })

  // Simple similarity: check overlap in words
  const proposalWords = new Set(
    (proposal.name + ' ' + proposal.description)
      .toLowerCase()
      .match(/\b\w+\b/g) || [],
  )

  let best: { slug: string; similarity: number } | null = null

  for (const cat of existing) {
    const categoryWords = new Set(
      (cat.name + ' ' + (cat.description || ''))
        .toLowerCase()
        .match(/\b\w+\b/g) || [],
    )

    const intersection = [...proposalWords].filter((w) => categoryWords.has(w)).length
    const union = new Set([...proposalWords, ...categoryWords]).size
    const similarity = union > 0 ? intersection / union : 0

    // At least 30% overlap to be considered a match
    if (similarity >= 0.3) {
      if (!best || similarity > best.similarity) {
        best = { slug: cat.slug, similarity }
      }
    }
  }

  return best
}

/**
 * Reconcile proposals against existing categories
 * Returns list of proposals to create + mapping of proposal idx to final category slug
 */
export async function reconcileProposals(
  proposals: CategoryProposal[],
): Promise<{
  toCreate: CategoryProposal[]
  mapping: Array<{ proposalIdx: number; finalSlug: string }>
}> {
  const toCreate: CategoryProposal[] = []
  const mapping: Array<{ proposalIdx: number; finalSlug: string }> = []

  for (let i = 0; i < proposals.length; i++) {
    const proposal = proposals[i]

    // Check for exact slug match first
    const existing = await prisma.category.findUnique({
      where: { slug: proposal.slug || generateSlug(proposal.name) },
    })

    if (existing) {
      mapping.push({ proposalIdx: i, finalSlug: existing.slug })
      continue
    }

    // Check for semantic similarity
    const closest = await findClosestCategory(proposal)
    if (closest && closest.similarity >= 0.6) {
      // Merge into closest
      mapping.push({ proposalIdx: i, finalSlug: closest.slug })
      continue
    }

    // No close match — mark for creation
    mapping.push({ proposalIdx: i, finalSlug: `_pending_${i}` })
    toCreate.push(proposal)
  }

  return { toCreate, mapping }
}

/**
 * Create proposed categories in DB
 */
export async function createCategories(proposals: CategoryProposal[]): Promise<Map<string, string>> {
  const slugMap = new Map<string, string>() // pending slug -> actual slug

  for (const proposal of proposals) {
    const slug = proposal.slug || generateSlug(proposal.name)
    const color = generateColor(slug)

    try {
      const created = await prisma.category.create({
        data: {
          name: proposal.name,
          slug,
          description: proposal.description,
          color,
          isAiGenerated: true,
        },
      })
      slugMap.set(`_pending_${proposals.indexOf(proposal)}`, created.slug)
    } catch (err) {
      console.error(`Failed to create category "${proposal.name}":`, err)
      // Fall back to "general" on creation failure
      slugMap.set(`_pending_${proposals.indexOf(proposal)}`, 'general')
    }
  }

  return slugMap
}
