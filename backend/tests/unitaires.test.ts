import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { d, ecartPct, m2, p4, q3, somme } from '../src/core/nombres.js';
import { controlerSommePonderale, convertirEnGrammes } from '../src/modules/formules/service.js';
import { calculerTotaux } from '../src/modules/ventes/service.js';
import { aLaPermission, PERMISSIONS, ROLES } from '../src/core/rbac.js';
import { codeBarresSvg, verifierTableMotifs } from '../src/modules/documents/codebarres.js';
import { ErreurMetier } from '../src/core/erreurs.js';

describe('Calculs de precision', () => {
  test('les montants ne subissent pas les arrondis du binaire flottant', () => {
    assert.equal(m2(d('0.1').plus('0.2')), '0.30');
    assert.equal(q3(somme(['68.500', '5.000', '0.500', '8.000', '6.000', '5.000', '4.000', '0.500', '1.000', '1.300', '0.200'])), '100.000');
    assert.equal(p4(d('1234.56789')), '1234.5679');
  });

  test("l'ecart de pesee est relatif a la consigne", () => {
    assert.equal(ecartPct(100.5, 100).toFixed(3), '0.500');
    assert.equal(ecartPct(99.5, 100).toFixed(3), '-0.500');
    assert.equal(ecartPct(100, 0).toFixed(3), '0.000');
  });

  test('conversion des unites d achat en grammes', () => {
    assert.equal(convertirEnGrammes(1, 'kg').toString(), '1000');
    assert.equal(convertirEnGrammes(2, 'L', 0.87).toString(), '1740');
    assert.equal(convertirEnGrammes(500, 'ml', 1.26).toString(), '630');
    assert.equal(convertirEnGrammes(250, 'g').toString(), '250');
  });
});

describe('Integrite ponderale des formules', () => {
  test('une somme exacte de 100,000 % est acceptee', () => {
    const total = controlerSommePonderale([
      { pourcentage_w_w: 68.5 }, { pourcentage_w_w: 30.4 }, { pourcentage_w_w: 1.1 },
    ]);
    assert.equal(total.toFixed(3), '100.000');
  });

  test('une somme de 99,80 % est rejetee avec le detail de l ecart', () => {
    assert.throws(
      () => controlerSommePonderale([{ pourcentage_w_w: 60 }, { pourcentage_w_w: 39.8 }]),
      (err: unknown) => {
        assert.ok(err instanceof ErreurMetier);
        assert.equal(err.code, 'FORMULE_SOMME_INVALIDE');
        assert.deepEqual(err.details, { somme: '99.800', ecart: '-0.200', attendu: '100.000' });
        return true;
      },
    );
  });

  test('un dixieme de millieme de trop est rejete', () => {
    assert.throws(
      () => controlerSommePonderale([{ pourcentage_w_w: 99.999 }, { pourcentage_w_w: 0.002 }]),
      (err: unknown) => err instanceof ErreurMetier && err.code === 'FORMULE_SOMME_INVALIDE'
        && (err.details as { somme: string }).somme === '100.001',
    );
  });
});

describe('Totaux des documents de vente', () => {
  test('remise puis TVA, arrondis au centime', () => {
    const totaux = calculerTotaux([
      { quantite: 100, prix_unitaire: 1850, remise_pct: 0, tva_pct: 19 },
      { quantite: 12, prix_unitaire: 3200, remise_pct: 10, tva_pct: 19 },
    ]);
    // 185 000 + (38 400 - 10 %) = 185 000 + 34 560 = 219 560
    assert.equal(totaux.total_ht, '219560.00');
    assert.equal(totaux.total_tva, '41716.40');
    assert.equal(totaux.total_ttc, '261276.40');
  });
});

describe('Matrice RBAC', () => {
  test("l'operateur de production est cloisonne", () => {
    for (const permission of ['client:lire', 'vente:lire', 'finance:lire', 'depense:lire', 'stock:liberer']) {
      assert.equal(aLaPermission('OPERATEUR_PRODUCTION', permission), false, permission);
    }
    for (const permission of ['production:peser', 'production:cuve', 'stock:lire']) {
      assert.equal(aLaPermission('OPERATEUR_PRODUCTION', permission), true, permission);
    }
  });

  test("l'administrateur dispose de tous les privileges", () => {
    for (const role of ROLES) {
      for (const permission of PERMISSIONS[role]) {
        if (permission !== '*') assert.equal(aLaPermission('ADMIN', permission), true, permission);
      }
    }
  });

  test('le commercial ne touche ni a la production ni a la comptabilite', () => {
    assert.equal(aLaPermission('COMMERCIAL', 'production:creer'), false);
    assert.equal(aLaPermission('COMMERCIAL', 'encaissement:ecrire'), false);
    assert.equal(aLaPermission('COMMERCIAL', 'vente:ecrire'), true);
  });
});

describe('Code-barres Code 128', () => {
  test('la table des motifs respecte les 11 modules par symbole', () => {
    assert.equal(verifierTableMotifs(), true);
  });

  test('le SVG genere encode la valeur et reste imprimable', () => {
    const svg = codeBarresSvg('LOT-MP-2026-00001');
    assert.match(svg, /^<svg xmlns/);
    assert.ok(svg.includes('LOT-MP-2026-00001'));
    assert.ok((svg.match(/<rect /g) ?? []).length > 20, 'le symbole comporte de nombreuses barres');
  });

  test('un caractere non encodable est refuse', () => {
    assert.throws(() => codeBarresSvg('LOT-É-001'), /Code 128/);
  });
});
