I want to create a set of agents that help me manage my finances. The agents will run inside of an interchange Hub.  The main interface will be a gui that has several workflows built into it, each one of which might have sub-workflows as required. There will be an Assets Manager agent, which  has the job of managing the information about my assets -- gathering them, using tools to connect to my banks and/or coinbase, etc. There will be a Taxes agent, which keeps track of my taxes, and reminds me to make payments when they are due.  There will be a Strategist agent which presents a chat box and brainstorms with me about strategies for managing my finances, wills, and my estate.  There will be a Market Manager that might advise me on what stocks or ETFs I should acquire.  What other agents should I have?  How should they communicate with each other?  What types of workflows will I need?  I would like to create a slide deck that talks about this product.

[ The above was used for the initial discussion starter with Claude.  Some of the brainstorming was not captured.  The output of the discussions where the deck and then the deck was used to create the build-plan.  We completed building phases I through IV, and we have a signed, distributal double-clickable MacOS app.  That app expects some input data to be present in json files, and so now I will tell the builder that it should gather that information and write those files ifself. ]

Currently, the app declares:

<app-text>
Welcome. Connect an institution read-only: list it in /Users/bfox/Library/Application Support/FinInterchange/institutions.json and drop an export into /Users/bfox/Library/Application Support/FinInterchange/institutions/<id>/inbox/ (JSON snapshot, or CSV with a column map). Or seed the fictional demo: fin-host init --demo 1.
</app-text>

This is an app for a non-programmer to use.  The user won't understand JSON data formats, or how to create files in their home directory.  They won't even be able to run "fin-host init --demo 1".  I would like the app to present two options when there is absolutely no data: "Currently, there are no institutions connected, and there's no other data for us to work with." And then two buttons: 1) "Click here to start connecting your institutions" and 2) "Click here to start with a bunch of made up data".

If there is already data present, the user should be able to add or delete institutions and modify their connected status.  The user should be able to manage the data about their assets in general using the GUI.

--------------------------------------------------------------------------------------------------------------------------------

We need to include Coinbase as a place to learn about crypto holdings, and we should be able to read a ledger wallet.
Most importantly -- the GUI is the place that the end user will interact with.  Users don't want to learn about the security CLI and how to use the command line.  So the user should be able to paste API keys and secrets once, and the app should store those in the Keychain.  The user should also be able to delete or modify those credentials.

--------------------------------------------------------------------------------------------------------------------------------

The estate planner should have both the chat box, and present a wizard to collect information that an estate planner must have!  For example, spouse, children, other people who should appear in a will, etc.  Please note that there's no onboarding path in place for collecting a user's name, social, country of origin, country of residence, etc.  We need this information available in the user's profile, and I should be collected from any agent that needs it (e.g, Estate Planning, Tax Planning). The chat box should be 4-6 lines tall, and the text should wrap.

--------------------------------------------------------------------------------------------------------------------------------
[Given to the app in the Profile page]
My name is Brian Jhan Fox, born in Boston on Dec 11, 1959. I have boy/girl twins who turn 26 on november 2 named Moses Daniel Liggett-Fox, and Lodiana Olivia Liggett-Fox.  I have a son named Bodhi Liggett who turns 35 on Nov 6.  Bodhi has a wife (Saskia) and a son (Koa). Koa was born on November 25, 2025