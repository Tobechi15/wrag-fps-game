// Displays the player's pot, split into SECURED (locked in by a previous
// extraction this match - safe even if killed now) and AT RISK (current
// unsecured earnings, lost if killed before the next extraction). This
// module never decides either number itself - it only renders whatever the
// SERVER reports (via 'shoot-result' and 'banked' messages, see
// server/src/match/match.js). Once real value is involved, the server must
// stay the only thing that can change these numbers.
export function createPotTracker(securedElement, atRiskElement, popupElement) {
  let secured = 0;
  let atRisk = 0;

  function render() {
    securedElement.textContent = `${secured}`;
    atRiskElement.textContent = `${atRisk}`;
  }

  // A brief "+N" float-up-and-fade on a point gain (see game.css's
  // pot-popup-float keyframes) - purely cosmetic, mirrors the number
  // setAtRisk is about to render anyway. Removing then re-adding the .pop
  // class (with a forced reflow in between, via reading offsetWidth) is
  // what lets a fast double-kill restart the animation cleanly instead of
  // a second call being silently ignored while the first is still playing.
  function showGainPopup(amount) {
    if (!popupElement || amount <= 0) return;
    popupElement.textContent = `+${amount}`;
    popupElement.classList.remove('pop');
    void popupElement.offsetWidth;
    popupElement.classList.add('pop');
  }

  // Called after a hit/kill - only the AT RISK (unsecured) number changes;
  // banking is a separate, explicit event (see setSecured). `newValue` is
  // always the full new total (never a delta - see match.js's
  // 'shoot-result'), so the popup's own delta is derived here.
  function setAtRisk(newValue) {
    if (newValue > atRisk) showGainPopup(newValue - atRisk);
    atRisk = newValue;
    render();
  }

  // Called when the server confirms a bank (extraction) - moves value into
  // the secured total and resets what's at risk, without ending the match.
  function setSecured(newSecured, newAtRisk) {
    secured = newSecured;
    atRisk = newAtRisk;
    render();
  }

  function getTotal() {
    return secured + atRisk;
  }

  render();
  return { setAtRisk, setSecured, getTotal };
}
