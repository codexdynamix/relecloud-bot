(() => {
  const telegram = window.Telegram?.WebApp;
  const elements = {
    firstName: document.querySelector("#first-name"),
    membershipPrice: document.querySelector("#membership-price"),
    membershipStatus: document.querySelector("#membership-status"),
    membershipButton: document.querySelector("#membership-button"),
    accessButton: document.querySelector("#access-button"),
    referralCount: document.querySelector("#referral-count"),
    pendingAmount: document.querySelector("#pending-amount"),
    paidAmount: document.querySelector("#paid-amount"),
    copyLinkButton: document.querySelector("#copy-link-button"),
    application: document.querySelector("#application"),
    applicationStatus: document.querySelector("#application-status"),
    applyButton: document.querySelector("#apply-button"),
    adminCard: document.querySelector("#admin-card"),
    adminApplications: document.querySelector("#admin-applications"),
    adminCommissions: document.querySelector("#admin-commissions"),
    notice: document.querySelector("#notice"),
  };
  let dashboard;
  let busy = false;

  if (!telegram?.initData) {
    elements.membershipStatus.textContent = "TELEGRAM REQUIRED";
    elements.membershipButton.textContent = "Open from Telegram";
    elements.application.disabled = true;
    showNotice("Open Relecloud Live from the Telegram channel to continue.", true);
    setDisabled(true);
    return;
  }

  setDisabled(true);
  telegram.ready();
  telegram.expand();

  async function api(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: {
        "X-Telegram-Init-Data": telegram.initData,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers,
      },
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Something went wrong. Please try again.");
    return result;
  }

  async function refresh() {
    dashboard = await api("/api/me");
    elements.firstName.textContent = dashboard.user.firstName || "friend";
    elements.membershipPrice.textContent = `${dashboard.priceStars} ★`;
    elements.referralCount.textContent = dashboard.referrals.paidReferralCount;
    elements.pendingAmount.textContent = money(dashboard.referrals.pendingCents);
    elements.paidAmount.textContent = money(dashboard.referrals.paidCents);

    if (dashboard.membershipActive) {
      elements.membershipStatus.textContent = "MEMBER";
      elements.membershipStatus.classList.add("is-active");
      elements.membershipButton.textContent = "Lifetime membership active";
      elements.membershipButton.disabled = true;
      elements.accessButton.hidden = false;
      elements.copyLinkButton.disabled = false;
      elements.copyLinkButton.textContent = "Copy your invite link";
      elements.application.disabled = false;
      elements.applyButton.disabled = false;
    } else {
      elements.membershipStatus.textContent = "MEMBERSHIP NEEDED";
      elements.membershipStatus.classList.remove("is-active");
      elements.membershipButton.textContent = "Join for lifetime access";
      elements.membershipButton.disabled = false;
      elements.accessButton.hidden = true;
      elements.copyLinkButton.disabled = true;
      elements.copyLinkButton.textContent = "Join to unlock your invite link";
      elements.application.disabled = true;
      elements.applyButton.disabled = true;
      elements.applicationStatus.textContent = "Join first to apply for a panel.";
    }

    if (dashboard.panelApplication) {
      elements.application.value = dashboard.panelApplication.application;
      const state = dashboard.panelApplication.status;
      elements.applicationStatus.textContent = state === "submitted"
        ? "Application received · hosts will review it"
        : state === "selected"
          ? "Selected · hosts will contact you"
          : "Reviewed · you can submit an updated application";
    }

    if (dashboard.isAdmin) {
      elements.adminCard.hidden = false;
      await refreshAdmin();
    }
  }

  async function refreshAdmin() {
    const overview = await api("/api/admin/overview");
    renderAdminApplications(overview.applications);
    renderAdminCommissions(overview.commissions);
  }

  function renderAdminApplications(applications) {
    elements.adminApplications.replaceChildren();
    appendHeading(elements.adminApplications, "Panel applications");
    if (applications.length === 0) {
      appendEmpty(elements.adminApplications, "No applications are waiting for review.");
      return;
    }

    for (const application of applications) {
      const item = document.createElement("article");
      item.className = "admin-item";
      const title = document.createElement("h3");
      title.textContent = `Application #${application.id} · ${application.username ? `@${application.username}` : `Member ${application.userId}`}`;
      const date = document.createElement("p");
      date.textContent = new Date(application.createdAt).toLocaleDateString();
      const message = document.createElement("p");
      message.textContent = application.application;
      const actions = document.createElement("div");
      actions.className = "admin-actions";
      actions.append(
        actionButton("Select", async () => decidePanel(application.id, "selected")),
        actionButton("Decline", async () => decidePanel(application.id, "declined"), true),
      );
      item.append(title, date, message, actions);
      elements.adminApplications.append(item);
    }
  }

  function renderAdminCommissions(commissions) {
    elements.adminCommissions.replaceChildren();
    appendHeading(elements.adminCommissions, "Affiliate payouts");
    if (commissions.length === 0) {
      appendEmpty(elements.adminCommissions, "No pending commissions.");
      return;
    }

    for (const commission of commissions) {
      const item = document.createElement("article");
      item.className = "admin-item";
      const title = document.createElement("h3");
      title.textContent = `$${(commission.amountCents / 100).toFixed(2)} USDT · ${commission.username ? `@${commission.username}` : `Member ${commission.referrerId}`}`;
      const eligible = document.createElement("p");
      eligible.textContent = commission.eligible
        ? "Eligible for payout"
        : `Available ${new Date(commission.eligibleAfter).toLocaleDateString()}`;
      const reference = document.createElement("input");
      reference.type = "text";
      reference.maxLength = 128;
      reference.placeholder = "Public transaction reference";
      reference.setAttribute("aria-label", `Transaction reference for commission ${commission.id}`);
      const markPaid = actionButton("Record as paid", async () => {
        await api("/api/admin/mark-paid", {
          method: "POST",
          body: JSON.stringify({ commissionId: commission.id, reference: reference.value.trim() }),
        });
        showNotice("Payout recorded.");
        await refreshAdmin();
      });
      markPaid.disabled = !commission.eligible;
      const actions = document.createElement("div");
      actions.className = "admin-actions";
      actions.append(reference, markPaid);
      item.append(title, eligible, actions);
      elements.adminCommissions.append(item);
    }
  }

  function appendHeading(parent, text) {
    const heading = document.createElement("h3");
    heading.textContent = text;
    parent.append(heading);
  }

  function appendEmpty(parent, text) {
    const message = document.createElement("p");
    message.className = "admin-empty";
    message.textContent = text;
    parent.append(message);
  }

  function actionButton(text, action, secondary = false) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = secondary ? "button button-secondary" : "button button-primary";
    button.textContent = text;
    button.addEventListener("click", async () => {
      if (busy) return;
      setBusy(true);
      try {
        await action();
      } catch (error) {
        showNotice(error.message, true);
      } finally {
        setBusy(false);
      }
    });
    return button;
  }

  async function decidePanel(applicationId, decision) {
    await api("/api/admin/panel-decision", {
      method: "POST",
      body: JSON.stringify({ applicationId, decision }),
    });
    showNotice(`Application ${decision}.`);
    await refreshAdmin();
  }

  elements.membershipButton.addEventListener("click", async () => {
    if (busy) return;
    setBusy(true);
    try {
      const { invoiceLink } = await api("/api/invoice", { method: "POST" });
      if (typeof telegram.openInvoice !== "function") {
        telegram.openLink(invoiceLink);
        showNotice("Your Telegram Stars invoice is ready. Complete it in Telegram, then refresh your membership status.");
        return;
      }
      telegram.openInvoice(invoiceLink, async (status) => {
        if (status === "paid") {
          showNotice("Payment received. Activating your lifetime membership…");
          for (let attempt = 0; attempt < 8; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
            await refresh();
            if (dashboard.membershipActive) {
              showNotice("You're in. Your lifetime membership is active.");
              return;
            }
          }
          showNotice("Payment received. Your membership is still processing—check back in a moment.");
        } else if (status === "failed") {
          showNotice("The payment could not be completed. Please try again.", true);
        }
      });
    } catch (error) {
      showNotice(error.message, true);
    } finally {
      setBusy(false);
    }
  });

  elements.accessButton.addEventListener("click", async () => {
    if (busy) return;
    setBusy(true);
    try {
      const { inviteLink } = await api("/api/access", { method: "POST" });
      telegram.openTelegramLink(inviteLink);
    } catch (error) {
      showNotice(error.message, true);
    } finally {
      setBusy(false);
    }
  });

  elements.copyLinkButton.addEventListener("click", async () => {
    if (!dashboard?.referralLink) return;
    try {
      await navigator.clipboard.writeText(dashboard.referralLink);
      showNotice("Your personal invite link is copied and ready to share.");
    } catch {
      window.prompt("Copy your personal invite link:", dashboard.referralLink);
    }
  });

  elements.applyButton.addEventListener("click", async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api("/api/panel-application", {
        method: "POST",
        body: JSON.stringify({ application: elements.application.value }),
      });
      await refresh();
      showNotice("Your application has been sent to the hosts for review.");
    } catch (error) {
      showNotice(error.message, true);
    } finally {
      setBusy(false);
    }
  });

  function setBusy(value) {
    busy = value;
    if (value) setDisabled(true);
    else if (dashboard) setDisabled(false);
  }

  function setDisabled(value) {
    if (!value) {
      elements.membershipButton.disabled = dashboard?.membershipActive ?? true;
      elements.accessButton.disabled = !(dashboard?.membershipActive ?? false);
      elements.copyLinkButton.disabled = !(dashboard?.membershipActive ?? false);
      elements.applyButton.disabled = !(dashboard?.membershipActive ?? false);
      return;
    }
    elements.membershipButton.disabled = true;
    elements.accessButton.disabled = true;
    elements.copyLinkButton.disabled = true;
    elements.applyButton.disabled = true;
  }

  function showNotice(message, isError = false) {
    elements.notice.textContent = message;
    elements.notice.classList.toggle("is-error", isError);
    elements.notice.hidden = false;
  }

  function money(cents) {
    return `$${(cents / 100).toFixed(2)}`;
  }

  refresh().catch((error) => showNotice(error.message, true));
})();
