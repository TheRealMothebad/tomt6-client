const cardState = new WeakMap();

// Init state
document.querySelectorAll('.card').forEach(card => {
  cardState.set(card, {
    zone: null,
    x: 50 + Math.random() * 500,
    y: 50 + Math.random() * 200
  });
  card.style.transform = `translate(${cardState.get(card).x}px, ${cardState.get(card).y}px)`;
});

// Utility
function clamp(v,min,max){return Math.max(min,Math.min(max,v));}

// Determine zone under card
function getZoneUnder(card) {
  const r = card.getBoundingClientRect();
  const cx = r.left + r.width/2;
  const cy = r.top + r.height/2;
  return [...document.querySelectorAll('.zone')]
    .find(z => {
      const zr = z.getBoundingClientRect();
      return cx>=zr.left && cx<=zr.right && cy>=zr.top && cy<=zr.bottom;
    });
}

function getCardsInZone(zoneName) {
  return [...document.querySelectorAll('.card')]
    .filter(c => cardState.get(c).zone === zoneName);
}

// Center and layout ordered zone
function layoutOrdered(zone, previewCard=null, previewIndex=null) {
  const zoneRect = zone.getBoundingClientRect();
  const zoneName = zone.dataset.zone;

  const cards = getCardsInZone(zoneName).filter(c => c !== previewCard);
  const total = cards.length + (previewCard ? 1 : 0);

  const spacing = 60;
  const startX = zoneRect.left + zoneRect.width/2 - ((total - 1) * spacing / 2);
  const y = zoneRect.top + zoneRect.height/2 - 85;

  let i = 0;
  cards.forEach(card => {
    if (previewCard && i === previewIndex) i++;
    const x = startX + i * spacing;
    i++;

    const state = cardState.get(card);
    state.x = x;
    state.y = y;
    card.style.transition = "transform 0.2s ease";
    card.style.transform = `translate(${x}px, ${y}px) rotateY(0deg) rotateX(0deg)`;
  });
}

function computeInsertIndex(zone, mouseX, exclude=null) {
  const zoneName = zone.dataset.zone;
  const cards = getCardsInZone(zoneName).filter(c => c !== exclude);

  for (let i=0;i<cards.length;i++){
    const r = cards[i].getBoundingClientRect();
    const mid = r.left + r.width/2;
    if(mouseX < mid) return i;
  }
  return cards.length;
}

function commitToOrdered(card, zone) {
  const zoneName = zone.dataset.zone;
  const rect = card.getBoundingClientRect();
  const mouseX = rect.left + rect.width/2;

  const list = getCardsInZone(zoneName);
  const index = computeInsertIndex(zone, mouseX);

  list.splice(index,0,card);
  layoutOrdered(zone);
  return list;
}

// CALLBACK
function onCardDropped(card, newZone, oldZone, orderList) {
  console.log("DROP:", {
    card: card.dataset.id,
    from: oldZone,
    to: newZone,
    order: orderList?.map(c=>c.dataset.id)
  });
}

// DRAG
interact('.card').draggable({
  listeners: {
    start(event) {
      event.target.style.zIndex = Date.now().toString();
      cardState.get(event.target).startZone = cardState.get(event.target).zone;
    },
    move(event) {
      const card = event.target;
      const state = cardState.get(card);
      state.x += event.dx;
      state.y += event.dy;

      const tiltY = clamp(event.dx * 0.2,-18,18);
      const tiltX = clamp(event.dy * -0.12,-12,12);

      card.style.transform =
        `translate(${state.x}px, ${state.y}px) rotateY(${tiltY}deg) rotateX(${tiltX}deg)`;

      const zone = getZoneUnder(card);
      if (zone && zone.classList.contains("ordered")) {
        const mx = card.getBoundingClientRect().left + card.getBoundingClientRect().width/2;
        const idx = computeInsertIndex(zone, mx, card);
        layoutOrdered(zone, card, idx);
      }
    },
    end(event) {
      const card = event.target;
      const state = cardState.get(card);
      const oldZone = state.zone;

      const zone = getZoneUnder(card);

      card.style.transition = "transform 0.18s ease";

      if (!zone) {
        card.style.transition = "";
        card.style.transform = `translate(${x}px, ${y}px) rotateY(0deg) rotateX(0deg)`;
        setTimeout(()=>card.style.transition="",180);
        return;
      }

      const zoneName = zone.dataset.zone;
      state.zone = zoneName;

      let orderedList = null;
      if(zone.classList.contains("ordered")) {
        orderedList = commitToOrdered(card, zone);
      } else {
        // Snap to center
        const zr=zone.getBoundingClientRect();
        state.x = zr.left + zr.width/2 - 60;
        state.y = zr.top + zr.height/2 - 85;
        card.style.transform =
          `translate(${state.x}px,${state.y}px) rotateY(0deg) rotateX(0deg)`;
      }

      onCardDropped(card, zoneName, oldZone, orderedList);
      setTimeout(()=>card.style.transition="",180);
    }
  }
});
