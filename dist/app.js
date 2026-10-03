(() => {
  "use strict";

  const data = window.POLLING_DATA;
  if (!data || !Array.isArray(data.records)) {
    document.body.innerHTML =
      '<main style="max-width:48rem;margin:4rem auto;padding:1rem" dir="rtl"><h1>המידע אינו זמין כרגע</h1><p>נסו לרענן את הדף בעוד כמה רגעים.</p></main>';
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
  const pageSize = 12;
  let activeResults = [];
  let visibleResultCount = pageSize;

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

  function googleMapsSearchUrl(location) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(googleMapsQuery(location))}`;
  }

  function googleMapsDirectionsUrl(location) {
    return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(googleMapsQuery(location))}&dir_action=navigate`;
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
    const mapLink = card.querySelector(".maps-link");
    mapLink.href = googleMapsSearchUrl(location);
    mapLink.setAttribute("aria-label", `הצגת ${addressText} במפות Google בחלון חדש`);
    const directionsLink = card.querySelector(".directions-link");
    directionsLink.href = googleMapsDirectionsUrl(location);
    directionsLink.setAttribute("aria-label", `קבלת מסלול אל ${addressText} במפות Google בחלון חדש`);
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
      empty.innerHTML =
        "<h3>לא נמצאה התאמה</h3><p>בדקו את האיות, נסו להזין רק את שם היישוב, או השתמשו באיתור היישוב.</p>";
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

  function checkCardMarkup(record, status) {
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
    return `
      <article class="check-card ${status}">
        <span class="status-badge ${badgeClass}">${badge}</span>
        <h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(explanation)}</p>
        <dl class="check-details">
          <div><dt>קלפי</dt><dd>${escapeHtml(record.ballot)}</dd></div>
          <div><dt>מקום</dt><dd>${escapeHtml(record.place || "לא צוין")}</dd></div>
          <div><dt>כתובת</dt><dd>${escapeHtml(addressText || "לא צוינה")}</dd></div>
          <div><dt>הוראות גישה</dt><dd>${escapeHtml(directions)}</dd></div>
        </dl>
        <p class="inline-map-note">המיקום במפה מבוסס על כתובת טקסטואלית ועלול להיות משוער.</p>
        <div class="card-actions check-actions">
          <a class="secondary-button" href="${escapeHtml(mapsUrl)}" target="_blank" rel="noopener noreferrer" aria-label="הצגת ${escapeHtml(addressText)} במפות Google בחלון חדש">
            הצגה במפות Google <span class="external-mark" aria-hidden="true">↗</span>
          </a>
          <a class="secondary-button" href="${escapeHtml(routeUrl)}" target="_blank" rel="noopener noreferrer" aria-label="קבלת מסלול אל ${escapeHtml(addressText)} במפות Google בחלון חדש">
            קבלת מסלול <span class="external-mark" aria-hidden="true">↗</span>
          </a>
        </div>
      </article>`;
  }

  function escapeHtml(value) {
    const node = document.createElement("span");
    node.textContent = String(value || "");
    return node.innerHTML;
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
      checkResult.innerHTML = checkCardMarkup(record, record.special ? "special" : "accessible");
      announce(
        record.special
          ? `קלפי ${record.ballot} ב${record.locality} מסומנת כנגישה מיוחדת.`
          : `קלפי ${record.ballot} ב${record.locality} מופיעה כנגישה אך אינה מסומנת כנגישה מיוחדת.`,
      );
    } else {
      checkResult.innerHTML = `
        <article class="check-card unknown">
          <span class="status-badge status-unknown">אין מידע מספיק</span>
          <h3>הקלפי לא נמצאה בדוח הקלפיות הנגישות</h3>
          <p>לא ניתן לקבוע מכך שהקלפי אינה נגישה. בדקו את המספר והיישוב ואמתו את המידע בפרסום הרשמי סמוך למועד הבחירות.</p>
        </article>`;
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

  document.getElementById("use-location").addEventListener("click", () => {
    const button = document.getElementById("use-location");
    if (!navigator.geolocation) {
      setFieldError(areaInput, areaError, "הדפדפן אינו תומך באיתור מיקום. הזינו יישוב ידנית.");
      areaInput.focus();
      return;
    }

    const originalLabel = button.innerHTML;
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
          button.innerHTML = originalLabel;
        }
      },
      () => {
        button.disabled = false;
        button.innerHTML = originalLabel;
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
