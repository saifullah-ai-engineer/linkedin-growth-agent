// content.js
// Runs on linkedin.com pages the user is already viewing.
// Reads ONLY visible text on the current page. Never scrapes hidden
// data, never reads data the user cannot see, never automates clicks,
// likes, connects, or sends, and never bypasses a CAPTCHA.
// Page context is sent to the side panel only when the user opens it.

(function () {
  "use strict";

  function cleanText(value) {
    if (!value) return "";
    return String(value).replace(/\s+/g, " ").trim();
  }

  function visibleTextOf(el) {
    if (!el) return "";
    // Only text the user can see: skip hidden elements.
    const style = window.getComputedStyle ? window.getComputedStyle(el) : null;
    if (style && (style.display === "none" || style.visibility === "hidden")) return "";
    return cleanText(el.innerText || el.textContent || "");
  }

  function firstText(selectors, limit) {
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      const text = visibleTextOf(el);
      if (text) return limit ? text.slice(0, limit) : text;
    }
    return "";
  }

  function detectPageType() {
    const path = window.location.pathname || "/";
    const url = window.location.href || "";
    if (path.startsWith("/messaging") || path.startsWith("/in/") && url.indexOf("/messaging") !== -1) return "messaging";
    if (path.startsWith("/messaging")) return "messaging";
    if (path.startsWith("/in/")) return "profile";
    if (path.startsWith("/company/")) return "company";
    if (path.startsWith("/feed") || path === "/" || path.startsWith("/posts/") || path.indexOf("/posts/") !== -1) return "feed";
    if (path.startsWith("/search")) return "search";
    return "other";
  }

  function readProfile() {
    const name = firstText(["h1", ".top-card-layout__title", ".pv-text-details__left-panel h1"], 200);
    const headline = firstText([".text-body-medium.break-words", ".pv-text-details__left-panel .text-body-medium"], 300);
    const about = firstText(["#about ~ div .inline-show-more-text", ".pv-shared-text-with-see-more .inline-show-more-text", "section#about .inline-show-more-text"], 2000);
    const main = document.querySelector("main");
    const visible = main ? cleanText(main.innerText || "").slice(0, 4000) : "";
    return {
      pageType: "profile",
      name: name,
      headline: headline,
      about: about,
      visibleText: visible
    };
  }

  function readFeedPost() {
    const post = firstText([".feed-shared-update-v2__description", ".update-components-text", "[data-urn] .update-components-text"], 2000);
    const author = firstText([".update-components-actor__title", ".feed-shared-actor__name"], 200);
    const main = document.querySelector("main");
    const visible = main ? cleanText(main.innerText || "").slice(0, 4000) : "";
    return {
      pageType: "feed",
      author: author,
      postText: post,
      visibleText: visible
    };
  }

  function readCompany() {
    const name = firstText(["h1", ".top-card-layout__title"], 200);
    const tagline = firstText([".top-card-layout__headline", ".org-top-card-summary__tagline"], 300);
    const about = firstText([".org-about-module__description", ".org-page-details__definition-text"], 2000);
    const main = document.querySelector("main");
    const visible = main ? cleanText(main.innerText || "").slice(0, 4000) : "";
    return {
      pageType: "company",
      name: name,
      tagline: tagline,
      about: about,
      visibleText: visible
    };
  }

  function readMessaging() {
    const main = document.querySelector("main");
    const visible = main ? cleanText(main.innerText || "").slice(0, 4000) : "";
    const threadTitle = firstText([".msg-thread__link-to-profile", ".msg-conversation-card__participant-names"], 200);
    return {
      pageType: "messaging",
      threadTitle: threadTitle,
      conversationText: visible,
      visibleText: visible
    };
  }

  function readPageContext() {
    const pageType = detectPageType();
    let context;
    if (pageType === "profile") context = readProfile();
    else if (pageType === "company") context = readCompany();
    else if (pageType === "messaging") context = readMessaging();
    else context = readFeedPost();
    context.pageType = pageType;
    context.url = window.location.href;
    context.title = cleanText(document.title || "").slice(0, 200);
    context.readAt = new Date().toISOString();
    return context;
  }

  // Respond only when the side panel or popup asks.
  // Nothing is sent automatically on page load.
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== "string") return false;
    if (message.type === "getPageContext") {
      try {
        sendResponse({ ok: true, context: readPageContext() });
      } catch (err) {
        sendResponse({ ok: false, error: "Could not read visible page text." });
      }
      return true;
    }
    if (message.type === "getPageType") {
      sendResponse({ ok: true, pageType: detectPageType(), url: window.location.href });
      return true;
    }
    return false;
  });
})();
