import { z } from 'zod';

export const UNITES_MP = ['g', 'kg', 'L', 'ml'] as const;

export const schemaArticle = z
  .object({
    code_sku: z.string().min(2).max(40).regex(/^[A-Z0-9._-]+$/i, 'Code SKU alphanumerique attendu.'),
    designation: z.string().min(2),
    type: z.enum(['MP', 'AC', 'PF']),
    unite: z.string().min(1),
    nom_inci: z.string().optional().nullable(),
    seuil_critique: z.coerce.number().min(0).default(0),
    prix_vente_ht: z.coerce.number().min(0).default(0),
    tva_pct: z.coerce.number().min(0).max(100).default(19),
    contenance_ml: z.coerce.number().positive().optional().nullable(),
    densite: z.coerce.number().positive().max(5, 'Masse volumique comprise entre 0 et 5 g/ml.').optional().nullable(),
    actif: z.boolean().default(true),
  })
  .superRefine((v, ctx) => {
    if (v.type === 'MP' && !UNITES_MP.includes(v.unite as (typeof UNITES_MP)[number])) {
      ctx.addIssue({ code: 'custom', path: ['unite'], message: "Une matiere premiere s'exprime en g, kg, L ou ml." });
    }
    if (v.type !== 'MP' && v.unite !== 'U') {
      ctx.addIssue({ code: 'custom', path: ['unite'], message: "Un AC ou un PF s'exprime en unites (U)." });
    }
    if (v.type === 'PF' && !v.contenance_ml) {
      ctx.addIssue({ code: 'custom', path: ['contenance_ml'], message: 'La contenance (ml) est obligatoire pour un produit fini.' });
    }
    if (v.type !== 'MP' && v.densite) {
      ctx.addIssue({ code: 'custom', path: ['densite'], message: 'La masse volumique ne concerne que les matieres premieres.' });
    }
    if (v.type !== 'PF' && v.contenance_ml) {
      ctx.addIssue({ code: 'custom', path: ['contenance_ml'], message: 'La contenance ne concerne que les produits finis.' });
    }
  });
