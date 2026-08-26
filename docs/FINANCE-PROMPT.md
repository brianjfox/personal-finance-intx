I want to create a set of agents that help me manage my finances. The agents will run inside of an interchange Hub.  The main interface will be a gui that has several workflows built into it, each one of which might have sub-workflows as required. There will be an Assets Manager agent, which  has the job of managing the information about my assets -- gathering them, using tools to connect to my banks and/or coinbase, etc. There will be a Taxes agent, which keeps track of my taxes, and reminds me to make payments when they are due.  There will be a Strategist agent which presents a chat box and brainstorms with me about strategies for managing my finances, wills, and my estate.  There will be a Market Manager that might advise me on what stocks or ETFs I should acquire.  What other agents should I have?  How should they communicate with each other?  What types of workflows will I need?  I would like to create a slide deck that talks about this product.

[ The above was used for the initial discussion starter with Claude.  Some of the brainstorming was not captured.  The output of the discussions where the deck and then the deck was used to create the build-plan.  We completed building phases I through IV, and we have a signed, distributal double-clickable MacOS app.  That app expects some input data to be present in json files, and so now I will tell the builder that it should gather that information and write those files ifself. ]

Currently, the app declares:

<app-text>
Welcome. Connect an institution read-only: list it in /Users/bfox/Library/Application Support/FinInterchange/institutions.json and drop an export into /Users/bfox/Library/Application Support/FinInterchange/institutions/<id>/inbox/ (JSON snapshot, or CSV with a column map). Or seed the fictional demo: fin-host init --demo 1.
</app-text>

This is an app for a non-programmer to use.  The user won't understand JSON data formats, or how to create files in their home directory.  They won't even be able to run "fin-host init --demo 1".  I would like the app to present two options when there is absolutely no data: "Currently, there are no institutions connected, and there's no other data for us to work with." And then two buttons: 1) "Click here to start connecting your institutions" and 2) "Click here to start with a bunch of made up data".

If there is already data present, the user should be able to add or delete institutions and modify their connected status.  The user should be able to manage the data about their assets in general using the GUI.

Whenever a number representing a fiat currency is being entered, be prepared to read the currency symbol and any other marks, such as commas and periods.  The type of currency should be stored with the value.  When displaying values, convert all currencies DYNAMICALLY into the user's preferred currency.

--------------------------------------------------------------------------------------------------------------------------------

We need to include Coinbase as a place to learn about crypto holdings, and we should be able to read a ledger wallet.
Most importantly -- the GUI is the place that the end user will interact with.  Users don't want to learn about the security CLI and how to use the command line.  So the user should be able to paste API keys and secrets once, and the app should store those in the Keychain.  The user should also be able to delete or modify those credentials.

--------------------------------------------------------------------------------------------------------------------------------

The estate planner should have both the chat box, and present a wizard to collect information that an estate planner must have!  For example, spouse, children, other people who should appear in a will, etc.  Please note that there's no onboarding path in place for collecting a user's name, social, country of origin, country of residence, etc.  We need this information available in the user's profile, and it should be collected from any agent that needs it (e.g, Estate Planning, Tax Planning). The chat box should be 4-6 lines tall, and the text should wrap.
--------------------------------------------------------------------------------------------------------------------------------

In the settings, the user should be able to assign an inference provider to each of Profile, Estate, Tax, and Strategy.
--------------------------------------------------------------------------------------------------------------------------------

The user should be able to provide multiple inference providers.  The form for doing so should show the most common ones in a dropdown, with an "Other OpenAI compatible Provider" option allowing the end user to specify the URL and keys.

--------------------------------------------------------------------------------------------------------------------------------
 If a user is entering text into a chat box, and then clicks away to a different tab, the text that has already been entered when the user returns to the original chat box.

--------------------------------------------------------------------------------------------------------------------------------
 A sample will produced by the Estate Planner should be saved as a Document, and be accesible in the Documents panel.  That panel should be tabbed as well, separating the types of documents that stored there, and filterable by creator (Estate, Tax, etc.), type (i.e., PDF, MD, Image, TXT, JSON, etc.), sortable by date, name, and other obvious triggers as you see fit.
 
--------------------------------------------------------------------------------------------------------------------------------
We are going to clean up the UX a little bit.  In Estate and Strategy the previous chats should be collapsed completely, but can be expanded with a disclosure toggle.  A summary of the remembered state should be displayed above the chat box, in an italic font with a subdued color.
