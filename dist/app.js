(() => {
  "use strict";

  const data = window.POLLING_DATA;
  if (!data || !Array.isArray(data.records)) {
    const failure = document.createElement("main");
    failure.className = "fatal-error";
    const heading = document.createElement("h1");
    heading.textContent = "המידע אינו זמין כרגע";
    const message = document.createElement("p");
    message.textContent = "נסו לרענן את הדף בעוד כמה רגעים.";
    failure.append(heading, message);
    document.body.replaceChildren(failure);
    return;
  }

  const records = data.records;
  const localeCollator = new Intl.Collator("he", { numeric: true, sensitivity: "base" });
  const numberFormatter = new Intl.NumberFormat("he-IL");
  const liveStatus = document.getElementById("live-status");
  const resultsSection = document.getElementById("results-section");
  const resultsList = document.getElementById("results-list");
  const resultsHeading = document.getElementById("results-heading");
  const resultsNote = document.getElementById("results-note");
  const loadMoreButton = document.getElementById("load-more");
  const checkResultSection = document.getElementById("check-result-section");
  const checkResult = document.getElementById("check-result");
  const checkResultHeading = document.getElementById("check-result-heading");
  const areaInput = document.getElementById("area-query");
  const areaError = document.getElementById("area-error");
  const localityInput = document.getElementById("check-locality");
  const localityError = document.getElementById("check-locality-error");
  const ballotInput = document.getElementById("ballot-number");
  const ballotError = document.getElementById("ballot-error");
  const resultTemplate = document.getElementById("result-card-template");
  const embeddedMapSection = document.getElementById("embedded-map-section");
  const embeddedMapHeading = document.getElementById("embedded-map-heading");
  const embeddedMapAddress = document.getElementById("embedded-map-address");
  const embeddedMapStatus = document.getElementById("embedded-map-status");
  const embeddedMap = document.getElementById("embedded-map");
  const walkingRouteLink = document.getElementById("walking-route-link");
  const osmMapLink = document.getElementById("osm-map-link");
  const pageSize = 12;
  const geocodeCache = new Map();
  let activeResults = [];
  let visibleResultCount = pageSize;
  let mapLoading = false;
  let mapAbortController = null;
  let mapReturnFocusElement = null;
  let lastGeocodeRequestAt = 0;

  function normalize(value) {
    return String(value || "")
      .normalize("NFKD")
      .replace(/[\u0591-\u05C7]/g, "")
      .replace(/[״”]/g, '"')
      .replace(/[׳’]/g, "'")
      .replace(/[–—־-]/g, " ")
      .replace(/[^\p{L}\p{N}.]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function normalizeBallot(value) {
    const normalized = normalize(value).replace(/\s/g, "");
    return normalized.replace(/\.0+$/, "");
  }

  const localities = [...new Set(records.map((record) => record.locality).filter(Boolean))].sort(localeCollator.compare);
  const normalizedLocalityMap = new Map(localities.map((locality) => [normalize(locality), locality]));

  const locationsMap = new Map();
  for (const record of records) {
    const key = [record.localityCode, record.address, record.place].join("\u0001");
    const current = locationsMap.get(key) || {
      locality: record.locality,
      localityCode: record.localityCode,
      address: record.address,
      place: record.place,
      directions: [],
      specialBallots: [],
      accessibleBallots: [],
      hasSpecial: false,
    };
    if (record.directions && !current.directions.includes(record.directions)) {
      current.directions.push(record.directions);
    }
    if (record.ballot && !current.accessibleBallots.includes(record.ballot)) {
      current.accessibleBallots.push(record.ballot);
    }
    if (record.special && record.ballot && !current.specialBallots.includes(record.ballot)) {
      current.specialBallots.push(record.ballot);
      current.hasSpecial = true;
    }
    locationsMap.set(key, current);
  }

  const specialLocations = [...locationsMap.values()]
    .filter((location) => location.hasSpecial)
    .map((location) => ({
      ...location,
      specialBallots: location.specialBallots.sort(localeCollator.compare),
      accessibleBallots: location.accessibleBallots.sort(localeCollator.compare),
      searchText: normalize([location.locality, location.address, location.place].join(" ")),
      localityNormalized: normalize(location.locality),
    }));

  function setSummary() {
    const { meta } = data;
    document.getElementById("special-count").textContent = numberFormatter.format(meta.specialAccessibleBallots);
    document.getElementById("special-count-bottom").textContent = numberFormatter.format(meta.specialAccessibleBallots);
    document.getElementById("accessible-count").textContent = numberFormatter.format(meta.accessibleBallots);
    document.getElementById("locality-count").textContent = numberFormatter.format(meta.localities);
  }

  function populateLocalities() {
    const fragment = document.createDocumentFragment();
    for (const locality of localities) {
      const option = document.createElement("option");
      option.value = locality;
      fragment.append(option);
    }
    document.getElementById("locality-list").append(fragment);
  }

  function announce(message) {
    liveStatus.textContent = "";
    window.setTimeout(() => {
      liveStatus.textContent = message;
    }, 30);
  }

  function setFieldError(input, errorElement, message) {
    input.setAttribute("aria-invalid", message ? "true" : "false");
    errorElement.textContent = message || "";
    errorElement.hidden = !message;
  }

  function switchPanel(tab, focusPanel = false) {
    const tabs = [...document.querySelectorAll('[role="tab"]')];
    for (const currentTab of tabs) {
      const selected = currentTab === tab;
      currentTab.classList.toggle("is-active", selected);
      currentTab.setAttribute("aria-selected", String(selected));
      currentTab.tabIndex = selected ? 0 : -1;
      document.getElementById(currentTab.dataset.panel).hidden = !selected;
    }
    if (focusPanel) {
      const firstInput = document.getElementById(tab.dataset.panel).querySelector("input");
      firstInput?.focus();
    }
  }

  const tabs = [...document.querySelectorAll('[role="tab"]')];
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => switchPanel(tab, true));
    tab.addEventListener("keydown", (event) => {
      let nextIndex = null;
      if (event.key === "ArrowLeft" || event.key === "ArrowDown") nextIndex = (index + 1) % tabs.length;
      if (event.key === "ArrowRight" || event.key === "ArrowUp") nextIndex = (index - 1 + tabs.length) % tabs.length;
      if (event.key === "Home") nextIndex = 0;
      if (event.key === "End") nextIndex = tabs.length - 1;
      if (nextIndex === null) return;
      event.preventDefault();
      tabs[nextIndex].focus();
      switchPanel(tabs[nextIndex]);
    });
  });

  function scoreLocation(location, query) {
    const queryTokens = query.split(" ").filter(Boolean);
    if (!queryTokens.length) return 0;

    let score = 0;
    if (location.localityNormalized === query) score += 1000;
    else if (location.localityNormalized.startsWith(query)) score += 700;
    else if (location.localityNormalized.includes(query)) score += 550;

    if (location.searchText === query) score += 500;
    else if (location.searchText.includes(query)) score += 350;

    const matchedTokens = queryTokens.filter((token) => location.searchText.includes(token));
    if (matchedTokens.length !== queryTokens.length) return score;
    score += 120 + matchedTokens.length * 35;

    if (queryTokens.some((token) => location.address && normalize(location.address).startsWith(token))) {
      score += 30;
    }
    return score;
  }

  function searchLocations(rawQuery) {
    const query = normalize(rawQuery);
    return specialLocations
      .map((location) => ({ location, score: scoreLocation(location, query) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        const localityOrder = localeCollator.compare(a.location.locality, b.location.locality);
        if (localityOrder) return localityOrder;
        return localeCollator.compare(a.location.address, b.location.address);
      })
      .map((entry) => entry.location);
  }

  function googleMapsQuery(location) {
    return [location.place, location.address, location.locality, "ישראל"].filter(Boolean).join(", ");
  }

  function nominatimQuery(location) {
    return [location.address || location.place, location.locality, "ישראל"].filter(Boolean).join(", ");
  }

  function googleMapsSearchUrl(location) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(googleMapsQuery(location))}`;
  }

  function googleMapsDirectionsUrl(location) {
    return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(googleMapsQuery(location))}&travelmode=walking&dir_action=navigate`;
  }

  function createElement(tagName, className, text) {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function restoreButtonContents(button, nodes) {
    button.replaceChildren(...nodes.map((node) => node.cloneNode(true)));
  }

  function mapEmbedUrl(latitude, longitude) {
    const latitudeDelta = 0.006;
    const longitudeDelta = 0.009;
    const params = new URLSearchParams({
      bbox: [
        longitude - longitudeDelta,
        latitude - latitudeDelta,
        longitude + longitudeDelta,
        latitude + latitudeDelta,
      ].join(","),
      layer: "mapnik",
      marker: `${latitude},${longitude}`,
    });
    return `https://www.openstreetmap.org/export/embed.html?${params.toString()}`;
  }

  function openStreetMapUrl(latitude, longitude) {
    const lat = encodeURIComponent(latitude);
    const lon = encodeURIComponent(longitude);
    return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=17/${lat}/${lon}`;
  }

  async function geocodeLocation(location, signal) {
    const query = nominatimQuery(location);
    if (geocodeCache.has(query)) return geocodeCache.get(query);

    const waitTime = Math.max(0, 1100 - (Date.now() - lastGeocodeRequestAt));
    if (waitTime) {
      await new Promise((resolve) => window.setTimeout(resolve, waitTime));
    }
    lastGeocodeRequestAt = Date.now();

    const params = new URLSearchParams({
      q: query,
      format: "jsonv2",
      addressdetails: "1",
      limit: "1",
      countrycodes: "il",
      "accept-language": "he",
    });
    const response = await fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`, {
      headers: { Accept: "application/json" },
      signal,
    });
    if (!response.ok) throw new Error("geocoding failed");
    const matches = await response.json();
    const firstMatch = Array.isArray(matches) ? matches[0] : null;
    const latitude = Number(firstMatch?.lat);
    const longitude = Number(firstMatch?.lon);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      throw new Error("location not found");
    }
    const match = {
      latitude,
      longitude,
      displayName: String(firstMatch.display_name || query),
    };
    geocodeCache.set(query, match);
    return match;
  }

  function closeEmbeddedMap(shouldFocus = true) {
    mapAbortController?.abort();
    mapAbortController = null;
    mapLoading = false;
    embeddedMapSection.hidden = true;
    embeddedMap.hidden = true;
    embeddedMap.removeAttribute("src");
    osmMapLink.hidden = true;
    embeddedMapStatus.textContent = "";
    if (shouldFocus) {
      const focusTarget = mapReturnFocusElement?.isConnected
        ? mapReturnFocusElement
        : document.querySelector('[role="tab"][aria-selected="true"]');
      focusTarget?.focus();
    }
    mapReturnFocusElement = null;
  }

  async function showEmbeddedMap(location, returnFocusElement) {
    mapReturnFocusElement = returnFocusElement || document.activeElement;
    const addressText = [location.place, location.address, location.locality].filter(Boolean).join(", ");
    embeddedMapSection.hidden = false;
    embeddedMapHeading.textContent = location.place ? `מפה: ${location.place}` : "מיקום הקלפי במפה";
    embeddedMapAddress.textContent = addressText;
    walkingRouteLink.href = googleMapsDirectionsUrl(location);
    walkingRouteLink.setAttribute(
      "aria-label",
      `פתיחת מסלול הליכה אל ${addressText} ב־Google Maps בחלון חדש. המסלול אינו בהכרח נגיש`,
    );
    embeddedMap.hidden = true;
    embeddedMap.removeAttribute("src");
    osmMapLink.hidden = true;
    embeddedMapStatus.textContent = mapLoading
      ? "מפה אחרת נטענת כעת. נסו שוב בעוד רגע."
      : "מאתרים את הכתובת ומכינים את המפה…";
    embeddedMapHeading.focus();
    embeddedMapSection.scrollIntoView({ block: "start" });

    if (mapLoading) {
      announce("מפה אחרת נטענת כעת. נסו שוב בעוד רגע.");
      return;
    }

    mapLoading = true;
    const controller = new AbortController();
    mapAbortController = controller;
    try {
      const match = await geocodeLocation(location, controller.signal);
      embeddedMap.src = mapEmbedUrl(match.latitude, match.longitude);
      embeddedMap.title = `מפה משוערת של ${addressText}`;
      embeddedMap.hidden = false;
      osmMapLink.href = openStreetMapUrl(match.latitude, match.longitude);
      osmMapLink.setAttribute("aria-label", `פתיחת ${addressText} ב־OpenStreetMap בחלון חדש`);
      osmMapLink.hidden = false;
      embeddedMapStatus.textContent = `נמצאה התאמה משוערת: ${match.displayName}`;
      announce(`המפה המשוערת של ${addressText} מוכנה.`);
    } catch {
      if (controller.signal.aborted) return;
      embeddedMapStatus.textContent =
        "לא הצלחנו למקם את הכתובת במפה. הכתובת ומסלול ההליכה ב־Google Maps עדיין זמינים.";
      announce("לא הצלחנו לטעון את המפה המוטמעת. אפשר להשתמש בקישור מסלול ההליכה.");
    } finally {
      if (mapAbortController === controller) {
        mapAbortController = null;
        mapLoading = false;
      }
    }
  }

  function createResultCard(location) {
    const card = resultTemplate.content.firstElementChild.cloneNode(true);
    const addressText = [location.address, location.locality].filter(Boolean).join(", ");
    card.querySelector(".place-name").textContent = location.place || "מקום הקלפי";
    card.querySelector(".address-line").textContent = addressText;
    const shownBallots = location.specialBallots.slice(0, 6).join(", ");
    const remaining = location.specialBallots.length - 6;
    card.querySelector(".ballot-list").textContent = `קלפיות ${shownBallots}${remaining > 0 ? ` ועוד ${remaining}` : ""}`;
    card.querySelector(".directions-text").textContent = location.directions.length
      ? location.directions.join(". ")
      : "לא נמסרו הוראות גישה מפורטות בדוח.";
    const embedMapButton = card.querySelector(".embed-map-button");
    embedMapButton.setAttribute("aria-label", `הצגת מפה משוערת של ${addressText} בתוך האתר`);
    embedMapButton.addEventListener("click", () => showEmbeddedMap(location, embedMapButton));
    const mapLink = card.querySelector(".maps-link");
    mapLink.href = googleMapsSearchUrl(location);
    mapLink.setAttribute("aria-label", `הצגת ${addressText} במפות Google בחלון חדש`);
    const directionsLink = card.querySelector(".directions-link");
    directionsLink.href = googleMapsDirectionsUrl(location);
    directionsLink.setAttribute(
      "aria-label",
      `פתיחת מסלול הליכה אל ${addressText} במפות Google בחלון חדש. המסלול אינו בהכרח נגיש`,
    );
    const copyButton = card.querySelector(".copy-button");
    copyButton.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(addressText);
        copyButton.textContent = "הכתובת הועתקה";
        announce(`הכתובת ${addressText} הועתקה`);
        window.setTimeout(() => {
          copyButton.textContent = "העתקת כתובת";
        }, 2200);
      } catch {
        copyButton.textContent = addressText;
        announce("לא ניתן היה להעתיק אוטומטית. הכתובת מוצגת בכפתור.");
      }
    });
    return card;
  }

  function renderResults() {
    resultsList.replaceChildren();
    const shown = activeResults.slice(0, visibleResultCount);
    if (!shown.length) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.append(
        createElement("h3", "", "לא נמצאה התאמה"),
        createElement(
          "p",
          "",
          "בדקו את האיות, נסו להזין רק את שם היישוב, או השתמשו באיתור היישוב.",
        ),
      );
      resultsList.append(empty);
      loadMoreButton.hidden = true;
      return;
    }

    const fragment = document.createDocumentFragment();
    shown.forEach((location) => fragment.append(createResultCard(location)));
    resultsList.append(fragment);
    loadMoreButton.hidden = visibleResultCount >= activeResults.length;
  }

  document.getElementById("find-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const rawQuery = areaInput.value.trim();
    if (rawQuery.length < 2) {
      setFieldError(areaInput, areaError, "הזינו לפחות שתי אותיות של יישוב או כתובת.");
      areaInput.focus();
      return;
    }
    setFieldError(areaInput, areaError, "");
    activeResults = searchLocations(rawQuery);
    visibleResultCount = pageSize;
    renderResults();
    resultsSection.hidden = false;
    const exactLocality = normalizedLocalityMap.get(normalize(rawQuery));
    resultsHeading.textContent = exactLocality
      ? `קלפיות נגישות מיוחדות ב${exactLocality}`
      : `תוצאות עבור „${rawQuery}”`;
    resultsNote.textContent = activeResults.length
      ? `נמצאו ${numberFormatter.format(activeResults.length)} מקומות. הדוח אינו כולל קואורדינטות, ולכן התוצאות מסודרות לפי התאמה ליישוב ולכתובת ולא לפי מרחק.`
      : "לא נמצאה קלפי מתאימה לביטוי שהוזן.";
    announce(
      activeResults.length
        ? `נמצאו ${numberFormatter.format(activeResults.length)} מקומות עם קלפי נגישה מיוחדת.`
        : "לא נמצאו תוצאות.",
    );
    resultsHeading.focus();
  });

  loadMoreButton.addEventListener("click", () => {
    visibleResultCount += pageSize;
    renderResults();
    announce(`מוצגות כעת ${Math.min(visibleResultCount, activeResults.length)} מתוך ${activeResults.length} תוצאות.`);
  });

  document.getElementById("clear-results").addEventListener("click", () => {
    resultsSection.hidden = true;
    resultsList.replaceChildren();
    activeResults = [];
    areaInput.value = "";
    areaInput.focus();
  });

  function closestKnownLocality(rawLocality) {
    const query = normalize(rawLocality);
    if (normalizedLocalityMap.has(query)) return normalizedLocalityMap.get(query);
    const starts = localities.filter((locality) => normalize(locality).startsWith(query));
    if (starts.length === 1) return starts[0];
    const contains = localities.filter((locality) => normalize(locality).includes(query));
    return contains.length === 1 ? contains[0] : "";
  }

  function appendCheckDetail(list, label, value) {
    const item = document.createElement("div");
    const term = createElement("dt", "", label);
    const description = createElement("dd", "", value);
    item.append(term, description);
    list.append(item);
  }

  function createExternalLink(className, href, label, ariaLabel) {
    const link = createElement("a", className, label);
    link.href = href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.setAttribute("aria-label", ariaLabel);
    link.append(createElement("span", "external-mark", "↗"));
    link.lastElementChild.setAttribute("aria-hidden", "true");
    return link;
  }

  function createCheckCard(record, status) {
    const addressText = [record.address, record.locality].filter(Boolean).join(", ");
    const title = status === "special"
      ? "הקלפי מסומנת כנגישה מיוחדת"
      : "הקלפי מופיעה בדוח הקלפיות הנגישות";
    const explanation = status === "special"
      ? "לפי הדוח שסופק, זו קלפי נגישה מיוחדת."
      : "לפי הדוח שסופק, הקלפי נגישה אך אינה מסומנת כנגישה מיוחדת.";
    const badge = status === "special" ? "נגישה מיוחדת" : "נגישה";
    const badgeClass = status === "special" ? "status-special" : "status-accessible";
    const directions = record.directions || "לא נמסרו הוראות גישה מפורטות בדוח.";
    const mapsUrl = googleMapsSearchUrl(record);
    const routeUrl = googleMapsDirectionsUrl(record);
    const card = document.createElement("article");
    card.className = `check-card ${status}`;
    card.append(
      createElement("span", `status-badge ${badgeClass}`, badge),
      createElement("h3", "", title),
      createElement("p", "", explanation),
    );

    const details = createElement("dl", "check-details");
    appendCheckDetail(details, "קלפי", record.ballot);
    appendCheckDetail(details, "מקום", record.place || "לא צוין");
    appendCheckDetail(details, "כתובת", addressText || "לא צוינה");
    appendCheckDetail(details, "הוראות גישה", directions);
    card.append(details);
    card.append(
      createElement(
        "p",
        "inline-map-note",
        "המיקום במפה מבוסס על כתובת טקסטואלית ועלול להיות משוער.",
      ),
    );

    const actions = createElement("div", "card-actions check-actions");
    const embedButton = createElement("button", "secondary-button embed-map-button", "מפה בתוך האתר");
    embedButton.type = "button";
    embedButton.setAttribute("aria-label", `הצגת מפה משוערת של ${addressText} בתוך האתר`);
    embedButton.addEventListener("click", () => showEmbeddedMap(record, embedButton));
    actions.append(
      embedButton,
      createExternalLink(
        "secondary-button",
        mapsUrl,
        "הצגה במפות Google ",
        `הצגת ${addressText} במפות Google בחלון חדש`,
      ),
      createExternalLink(
        "secondary-button",
        routeUrl,
        "מסלול הליכה ",
        `פתיחת מסלול הליכה אל ${addressText} במפות Google בחלון חדש. המסלול אינו בהכרח נגיש`,
      ),
    );
    card.append(actions);
    return card;
  }

  function createUnknownCheckCard() {
    const card = createElement("article", "check-card unknown");
    card.append(
      createElement("span", "status-badge status-unknown", "אין מידע מספיק"),
      createElement("h3", "", "הקלפי לא נמצאה בדוח הקלפיות הנגישות"),
      createElement(
        "p",
        "",
        "לא ניתן לקבוע מכך שהקלפי אינה נגישה. בדקו את המספר והיישוב ואמתו את המידע בפרסום הרשמי סמוך למועד הבחירות.",
      ),
    );
    return card;
  }

  document.getElementById("check-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const rawLocality = localityInput.value.trim();
    const rawBallot = ballotInput.value.trim();
    let hasError = false;

    if (rawLocality.length < 2) {
      setFieldError(localityInput, localityError, "הזינו את יישוב הקלפי.");
      hasError = true;
    } else {
      setFieldError(localityInput, localityError, "");
    }

    if (!rawBallot) {
      setFieldError(ballotInput, ballotError, "הזינו מספר קלפי.");
      hasError = true;
    } else {
      setFieldError(ballotInput, ballotError, "");
    }

    if (hasError) {
      (localityError.hidden ? ballotInput : localityInput).focus();
      return;
    }

    const locality = closestKnownLocality(rawLocality);
    if (!locality) {
      setFieldError(localityInput, localityError, "לא נמצא יישוב יחיד תואם. בחרו יישוב מהרשימה או בדקו את האיות.");
      localityInput.focus();
      return;
    }

    localityInput.value = locality;
    const record = records.find(
      (item) => normalize(item.locality) === normalize(locality) && normalizeBallot(item.ballot) === normalizeBallot(rawBallot),
    );

    checkResultSection.hidden = false;
    if (record) {
      checkResult.replaceChildren(createCheckCard(record, record.special ? "special" : "accessible"));
      announce(
        record.special
          ? `קלפי ${record.ballot} ב${record.locality} מסומנת כנגישה מיוחדת.`
          : `קלפי ${record.ballot} ב${record.locality} מופיעה כנגישה אך אינה מסומנת כנגישה מיוחדת.`,
      );
    } else {
      checkResult.replaceChildren(createUnknownCheckCard());
      announce(`לא נמצא מידע בדוח עבור קלפי ${rawBallot} ב${locality}.`);
    }
    checkResultHeading.focus();
  });

  document.getElementById("clear-check").addEventListener("click", () => {
    checkResultSection.hidden = true;
    checkResult.replaceChildren();
    localityInput.value = "";
    ballotInput.value = "";
    localityInput.focus();
  });

  document.getElementById("close-map").addEventListener("click", () => closeEmbeddedMap());

  document.getElementById("use-location").addEventListener("click", () => {
    const button = document.getElementById("use-location");
    if (!navigator.geolocation) {
      setFieldError(areaInput, areaError, "הדפדפן אינו תומך באיתור מיקום. הזינו יישוב ידנית.");
      areaInput.focus();
      return;
    }

    const originalContents = [...button.childNodes].map((node) => node.cloneNode(true));
    button.disabled = true;
    button.textContent = "מאתרים את היישוב…";
    announce("מאתרים את היישוב לפי המיקום הנוכחי.");

    navigator.geolocation.getCurrentPosition(
      async ({ coords }) => {
        try {
          const response = await fetch(
            `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(coords.latitude)}&lon=${encodeURIComponent(coords.longitude)}&zoom=10&addressdetails=1&accept-language=he`,
            { headers: { Accept: "application/json" } },
          );
          if (!response.ok) throw new Error("reverse geocoding failed");
          const place = await response.json();
          const address = place.address || {};
          const candidates = [address.city, address.town, address.village, address.municipality, address.city_district].filter(Boolean);
          const match = candidates.map(closestKnownLocality).find(Boolean);
          if (!match) throw new Error("locality not found");
          areaInput.value = match;
          setFieldError(areaInput, areaError, "");
          announce(`זוהה היישוב ${match}. אפשר להפעיל את החיפוש.`);
          document.getElementById("find-form").requestSubmit();
        } catch {
          setFieldError(areaInput, areaError, "לא הצלחנו לזהות את היישוב. הזינו אותו ידנית.");
          areaInput.focus();
        } finally {
          button.disabled = false;
          restoreButtonContents(button, originalContents);
        }
      },
      () => {
        button.disabled = false;
        restoreButtonContents(button, originalContents);
        setFieldError(areaInput, areaError, "הרשאת המיקום לא ניתנה. אפשר להמשיך בהזנת יישוב ידנית.");
        areaInput.focus();
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 },
    );
  });

  function registerWebMcpTools() {
    const context = document.modelContext;
    if (!context?.registerTool) return;

    const lifecycle = new AbortController();
    window.addEventListener("pagehide", () => lifecycle.abort(), { once: true });

    const tools = [
      {
        name: "search_special_accessible_polling_places",
        title: "חיפוש קלפיות נגישות מיוחדות",
        description:
          "Search the supplied polling-station report by Israeli locality, street, or address, update the visible results, and return matching special-accessible polling places. Results are ranked by text relevance, not distance.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              minLength: 2,
              description: "Hebrew locality, street, or full address to search for.",
            },
          },
          required: ["query"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true, untrustedContentHint: true },
        execute(input) {
          const query = typeof input?.query === "string" ? input.query.trim() : "";
          if (query.length < 2) throw new Error("יש להזין לפחות שתי אותיות לחיפוש.");
          switchPanel(document.getElementById("find-tab"));
          areaInput.value = query;
          document.getElementById("find-form").requestSubmit();
          return {
            query,
            resultCount: activeResults.length,
            ordering: "text_relevance_not_distance",
            sample: activeResults.slice(0, 5).map((location) => ({
              locality: location.locality,
              address: location.address,
              place: location.place,
              specialBallots: location.specialBallots,
              accessDirections: location.directions,
              googleMapsUrl: googleMapsSearchUrl(location),
              googleMapsDirectionsUrl: googleMapsDirectionsUrl(location),
            })),
          };
        },
      },
      {
        name: "check_polling_station_accessibility",
        title: "בדיקת נגישות קלפי",
        description:
          "Check one polling-station number within an Israeli locality against the supplied detailed report, update the visible check result, and distinguish special-accessible, accessible, and not found in this source.",
        inputSchema: {
          type: "object",
          properties: {
            locality: {
              type: "string",
              minLength: 2,
              description: "The polling station's locality in Hebrew.",
            },
            ballot: {
              type: "string",
              minLength: 1,
              description: "Polling-station number, such as 11.2 or 4.0.",
            },
          },
          required: ["locality", "ballot"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true, untrustedContentHint: true },
        execute(input) {
          const rawLocality = typeof input?.locality === "string" ? input.locality.trim() : "";
          const rawBallot = typeof input?.ballot === "string" ? input.ballot.trim() : "";
          if (rawLocality.length < 2 || !rawBallot) {
            throw new Error("יש להזין יישוב ומספר קלפי.");
          }
          const locality = closestKnownLocality(rawLocality);
          if (!locality) throw new Error("לא נמצא יישוב יחיד תואם במקור שסופק.");

          switchPanel(document.getElementById("check-tab"));
          localityInput.value = locality;
          ballotInput.value = rawBallot;
          document.getElementById("check-form").requestSubmit();
          const record = records.find(
            (item) => normalize(item.locality) === normalize(locality) && normalizeBallot(item.ballot) === normalizeBallot(rawBallot),
          );
          if (!record) {
            return {
              locality,
              ballot: rawBallot,
              status: "not_found_in_supplied_source",
              meaning: "Accessibility cannot be determined from this absence.",
            };
          }
          return {
            locality: record.locality,
            ballot: record.ballot,
            status: record.special ? "special_accessible" : "accessible",
            address: record.address,
            place: record.place,
            accessDirections: record.directions || null,
            googleMapsUrl: googleMapsSearchUrl(record),
            googleMapsDirectionsUrl: googleMapsDirectionsUrl(record),
          };
        },
      },
    ];

    for (const tool of tools) {
      try {
        void Promise.resolve(context.registerTool(tool, { signal: lifecycle.signal })).catch(() => {});
      } catch {
        // Unsupported or rejected tool registration must not affect the visible site.
      }
    }
  }

  setSummary();
  populateLocalities();
  registerWebMcpTools();
})();
