// DOM extraction adapted from the existing extension; no extension APIs or local HTTP access.
(() => {
  function textClean(s) {
    return String(s || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .trim();
  }

  function linesOf(el) {
    return (el?.innerText || '')
      .split(/\n+/)
      .map(textClean)
      .filter(Boolean);
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function isRevealControl(el) {
    if (!el) return false;

    const text = textClean(
      el.innerText ||
      el.textContent ||
      el.getAttribute?.('aria-label')
    );

    return (
      text.toLowerCase().includes('afficher le n°') ||
      text.toLowerCase().includes('afficher le numéro') ||
      text.toLowerCase().includes('voir le numéro') ||
      text.toLowerCase().includes('voir le n°')
    );
  }

  // ============================================================
  // DÉTECTION DES FICHES PARTICULIER
  // ============================================================

  function getParticulierCards() {
    // 1) Structure PagesJaunes actuellement observée.
    let cards = Array.from(
      document.querySelectorAll('li.bi.bi-generic')
    ).filter(card => {
      const badge = card.querySelector(
        '.badge-particulier, .row-badge-particulier'
      );
      return !!badge && /PARTICULIER/i.test(textClean(card.innerText));
    });

    if (cards.length) {
      return cards;
    }

    // 2) Fallback robuste si PagesJaunes change légèrement ses classes.
    // On remonte depuis les badges PARTCULIER vers la fiche parente.
    const fromBadges = Array.from(
      document.querySelectorAll(
        '.badge-particulier, .row-badge-particulier'
      )
    )
      .map(badge =>
        badge.closest(
          'li, article, [class*="bi-generic"], [class*="result"], [class*="card"]'
        )
      )
      .filter(Boolean)
      .filter(card => /PARTICULIER/i.test(textClean(card.innerText)));

    cards = Array.from(new Set(fromBadges));

    if (cards.length) {
      return cards;
    }

    // 3) Dernier fallback : partir des boutons de révélation encore visibles.
    const revealControls = Array.from(
      document.querySelectorAll('button, a, [role="button"]')
    ).filter(isRevealControl);

    const fromButtons = revealControls
      .map(control => {
        let current = control;
        let best = null;

        for (let depth = 0; depth < 12 && current; depth += 1) {
          const text = textClean(current.innerText);

          if (
            /PARTICULIER/i.test(text) &&
            text.length >= 20 &&
            text.length <= 4000
          ) {
            best = current;

            if (
              current.tagName === 'LI' ||
              current.tagName === 'ARTICLE'
            ) {
              break;
            }
          }

          current = current.parentElement;
        }

        return best;
      })
      .filter(Boolean);

    return Array.from(new Set(fromButtons));
  }

  // ============================================================
  // IDENTIFIANT UNIQUE D'UNE FICHE
  // ============================================================

  function getCardId(card) {
    if (!card) return null;
    if (card.id) return `html:${card.id}`;

    // IMPORTANT :
    // PagesJaunes peut remplacer le DOM d'une fiche après le clic.
    // On évite donc de dépendre uniquement de card.id ou du nœud DOM.
    // Nom + adresse donnent une clé stable après re-rendu.
    const name = textClean(extractNameFromCard(card)).toLowerCase();
    const address = textClean(extractAddressFromCard(card)).toLowerCase();

    if (name || address) {
      return `particulier:${name}|${address}`;
    }

    // Fallback : data-pjajax si le nom/adresse ne sont pas encore disponibles.
    const button = card.querySelector(
      'button[data-pjajax], a[data-pjajax], [role="button"][data-pjajax]'
    );

    if (button) {
      const ajaxData = button.getAttribute('data-pjajax');

      if (ajaxData) {
        return `pjajax:${ajaxData}`;
      }
    }

    // Dernier fallback seulement.
    if (card.id) {
      return `html:${card.id}`;
    }

    return null;
  }

  function findLiveParticulierCardById(cardId) {
    if (!cardId) return null;

    return (
      getParticulierCards().find(
        card => getCardId(card) === cardId
      ) || null
    );
  }

  // ============================================================
  // BOUTON "AFFICHER LE N°" D'UNE FICHE
  // ============================================================

  function findShowNumberButton(card) {
    if (!card) return null;

    const elements = Array.from(
      card.querySelectorAll(
        'button, a, [role="button"]'
      )
    );

    return elements.find(isRevealControl) || null;
  }

  // ============================================================
  // EXTRACTION DU NOM
  // ============================================================

  function extractNameFromCard(card) {
    if (!card) return '';

    const h3 = card.querySelector(
      'a.bi-denomination h3'
    );

    if (h3) {
      return textClean(h3.innerText || h3.textContent);
    }

    const denomination = card.querySelector(
      '.bi-denomination'
    );

    if (denomination) {
      return textClean(
        denomination.innerText ||
        denomination.textContent
      );
    }

    const lines = linesOf(card);

    const index = lines.findIndex(
      line => /^PARTICULIER$/i.test(line)
    );

    if (index >= 0) {
      const ignore = [
        'PARTICULIER',
        'Afficher le N°',
        'Afficher le numéro',
        'Voir le numéro',
        'Voir le N°',
        'Voir le plan',
        'Itinéraire',
        'Appeler'
      ];

      return (
        lines.slice(index + 1).find(line =>
          !ignore.some(
            ignored =>
              line.toLowerCase() ===
              ignored.toLowerCase()
          ) &&
          !/\b\d{5}\b/.test(line) &&
          !/^\d+\s/.test(line) &&
          line.length >= 3 &&
          line.length <= 100
        ) || ''
      );
    }

    return '';
  }

  // ============================================================
  // EXTRACTION DE L'ADRESSE
  // ============================================================

  function extractAddressFromCard(card) {
    if (!card) return '';

    const addressElement = card.querySelector(
      '.bi-address'
    );

    if (addressElement) {
      return textClean(
        addressElement.innerText ||
        addressElement.textContent
      ).replace(/\s*(?:Voir le plan|Itinéraire)\s*$/i, '').trim();
    }

    const lines = linesOf(card);

    return (
      lines.find(
        line =>
          /\b\d{5}\b/.test(line) &&
          !/^PARTICULIER$/i.test(line)
      ) || ''
    );
  }

  // ============================================================
  // EXTRACTION DU TÉLÉPHONE
  // ============================================================

  function extractPhoneFromCard(card) {
    if (!card) return '';

    // ----------------------------------------------------------
    // 1. Cherche d'abord dans le conteneur Fantomas
    // ----------------------------------------------------------

    const fantomas = card.querySelector(
      '.bi-fantomas'
    );

    if (fantomas) {
      const text = textClean(
        fantomas.innerText ||
        fantomas.textContent
      );

      const matches = text.match(
        /(?:\+33\s?[1-9]|0[1-9])(?:[\s.-]?\d{2}){4}/g
      );

      if (matches?.length) {
        return matches[0];
      }
    }

    // ----------------------------------------------------------
    // 2. Recherche dans toute la fiche
    // ----------------------------------------------------------

    const text = textClean(card.innerText);

    const matches = text.match(
      /(?:\+33\s?[1-9]|0[1-9])(?:[\s.-]?\d{2}){4}/g
    );

    return matches?.[0] || '';
  }

  // ============================================================
  // SPLIT NOM / PRÉNOM
  // ============================================================

  function splitName(fullName) {
    const parts = textClean(fullName)
      .split(/\s+/)
      .filter(Boolean);

    if (parts.length >= 2) {
      return {
        lastName: parts[0],
        firstName: parts.slice(1).join(' ')
      };
    }

    if (parts.length === 1) {
      return {
        lastName: parts[0],
        firstName: ''
      };
    }

    return {
      lastName: '',
      firstName: ''
    };
  }

  // ============================================================
  // EXTRACTION COMPLÈTE D'UNE FICHE
  // ============================================================

  function extractFromCard(card) {
    if (!card) {
      return {
        status: 'NOT_FOUND',
        fullName: '',
        lastName: '',
        firstName: '',
        phone: '',
        address: '',
        sourceUrl: location.href
      };
    }

    const fullName = extractNameFromCard(card);
    const address = extractAddressFromCard(card);
    const phone = extractPhoneFromCard(card);

    const {
      lastName,
      firstName
    } = splitName(fullName);

    return {
      status: fullName
        ? 'CAPTURED_REVIEW'
        : 'NOT_FOUND',

      fullName,
      lastName,
      firstName,
      phone,
      address,

      sourceUrl: location.href
    };
  }


  window.pbReader = {
    scan: () => getParticulierCards().map(card => ({ id: getCardId(card), ...extractFromCard(card) })),
    reveal: id => {
      const card = findLiveParticulierCardById(id);
      if (!card) return false;
      if (extractPhoneFromCard(card)) return false;
      const button = findShowNumberButton(card);
      if (!button) return false;
      card.scrollIntoView({ block: 'center' });
      button.click();
      return true;
    },
    pageState: () => {
      const text = document.body?.innerText || '';
      if (/captcha|vérifiez que vous êtes humain|verify you are human|access denied|accès refusé|unusual traffic/i.test(text)) return 'blocked';
      if (
        /aucun résultat|aucun particulier|aucune réponse|nous n.avons pas trouvé|(?:nous\s+)?n['’]?avons\s+pas\s+encore\s+de\s+réponse\s+à\s+cette\s+recherche/i.test(text)
      ) return 'empty';
      return 'unknown';
    }
  };
})();
