import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompletionDocumentsPdf } from './completion-attestation-pdf.js';

test('l’attestation de réussite conserve quatre objectifs, y compris après un retour à la ligne', () => {
  const objectives = [
    'Comprendre les enjeux du contrôle des filtres THE.',
    'Adopter les bonnes pratiques pour la réalisation des essais in situ.',
    'Anticiper les problématiques fréquemment rencontrées en ventilation : distance de mélange.',
    'Appréhender les hétérogénéités avec des solutions alternatives.'
  ];
  const pdf = createCompletionDocumentsPdf([{
    attestation_number:'TEST-001',
    participant_snapshot:{first_name:'Camille',last_name:'Durand'},
    form_snapshot:{
      organization_name:'Tech Systèmes',representative_name:'Responsable',
      training_title:'Formation test',objective:objectives.map(item => `- ${item}`).join('\n'),
      start_date:'2026-10-01',end_date:'2026-10-02',duration_value:2,duration_unit:'days',
      issue_place:'Paris',issue_date:'2026-10-02'
    }
  }],{kinds:['realisation']}).toString('latin1');
  for (const objective of objectives) assert.match(pdf,new RegExp(objective.split(' ')[0].replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  assert.ok(pdf.includes(objectives[2]),'le troisième objectif tient sur une seule ligne lorsque la largeur le permet');
});

test('les attestations conservent des libellés non gras et un bloc de résultat sur une ligne', () => {
  const pdf = createCompletionDocumentsPdf([{
    attestation_number:'TEST-002',
    participant_snapshot:{first_name:'Camille',last_name:'Durand'},
    form_snapshot:{
      organization_name:'Tech Systèmes',representative_name:'Responsable',training_title:'Formation test',
      issue_place:'Paris',issue_date:'2026-10-02',
      attestation_certification_text:'certifie que {participant}\na suivi l’intégralité de la formation :',
      realization_training_text:'a suivi l’action de formation : {formation}'
    }
  }]).toString('latin1');
  assert.match(pdf,/\/F1 11 Tf[^]*?\(a suivi l'intégralité de la formation:\)/);
  assert.match(pdf,/\/F1 9 Tf[^]*?\(a suivi l'action de formation: Formation test\)/);
  assert.ok(pdf.includes("et a obtenu un avis \" favorable \" à l'issue de la validation des acquis."),'le résultat de validation reste sur une ligne');
  assert.match(pdf,/ Tw \(Sans préjudice des délais imposés par les règles fiscales,/,'la mention de conservation est justifiée');
});
