import { useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { ModaleFournisseur } from '../pages/Fournisseurs';
import { Champ, useChargement } from './Ui';

/**
 * Liste des fournisseurs actifs, avec creation a la volee : le fournisseur cree
 * est aussitot selectionne, sans quitter le formulaire en cours.
 */
export function ChoixFournisseur({ valeur, onChange, libelle = 'Fournisseur' }: {
  valeur: string; onChange: (id: string) => void; libelle?: string;
}) {
  const { peut } = useAuth();
  const fournisseurs = useChargement(() => api.get('/fournisseurs?actif=true'));
  const [creation, setCreation] = useState(false);
  const ecriture = peut('achat:ecrire') || peut('depense:ecrire');

  return (
    <>
      <Champ libelle={libelle}
        aide={!fournisseurs.enCours && !fournisseurs.donnees?.length ? 'Aucun fournisseur actif : en creer un avec « + Nouveau ».' : undefined}>
        <div style={{ display: 'flex', gap: 6 }}>
          <select style={{ flex: 1, minWidth: 0 }} value={valeur} onChange={(e) => onChange(e.target.value)}>
            <option value="">—</option>
            {(fournisseurs.donnees ?? []).map((f: any) => <option key={f.id} value={f.id}>{f.raison_sociale} ({f.code})</option>)}
          </select>
          {ecriture && (
            <button type="button" className="bouton petit" onClick={(e) => { e.preventDefault(); setCreation(true); }}
              title="Creer un fournisseur">+ Nouveau</button>
          )}
        </div>
      </Champ>
      {creation && (
        <ModaleFournisseur onFermer={() => setCreation(false)}
          onEnregistre={(f) => { setCreation(false); fournisseurs.recharger(); onChange(String(f.id)); }} />
      )}
    </>
  );
}
