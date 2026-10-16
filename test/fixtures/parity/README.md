# DCSC browser contracts

Captured anonymously on 2026-10-15 using headless Chromium against Lenovo DCSC,
US / English / USD / General Purpose / SR630 V3 (`7D73CTO1WW`).

- `sr630-launch.json`: launch response with unrelated feature choices removed;
  selected hardware, software groups/filters, service choices, derived sections,
  associated products and prices retained.
- `sr630-browser-sections.json`: all 34 sections posted by the website on a no-op
  auto-derive. No session IDs or credentials are present in these sections.

The complete original captures remain in the local audit directory. Tests assert
serialization semantics, including duplicate derived software entries emitted by
the website, rather than assuming hardware-only results are sufficient. Live
price checks must compare contemporaneous responses, not these historical prices.


Additional contracts from the same anonymous/headless audit:

- `software-priced-cal-quantity.json`: captured merged-CTO CAL parent, HIPO
  envelope and complete quantity-three request expectations. Preserves the
  website's duplicate derived entries, selector quantity and companion line;
  source/provenance is included in the fixture.
- `sr630-software-quantity-response.json`: partial software auto-derive response;
  reconciled with the SPA's software reducer, including hardware-derived lines.
- `browser-quantity-matrix.json`: browser-exported server quantities 1/4/8 and
  standalone software quantity 3. Software `standaloneData.price` is unit price;
  group `price` is extended. XML feature quantities remain per-unit.
- `lfo-import-customize-contract.json`: a current mixed LFO plus standalone
  software import, layout customization, explicit hardware recustomization and
  `/lfos/export_zip` handoff. Dynamic browser identities stay in the hashed raw
  evidence; this compact fixture records the endpoint and payload semantics.
- `lfo-hardware-edit-contract.json`: the real ST250 V3 `BFYE` to `BFYB`
  mutation through the browser and MCP. It records matching delta/state/prices
  and the accepted request-envelope differences without dynamic identities.
- `lfo-as-cto-contract.json` and `lfo-as-cto-export-groups.json`: direct website
  capture of a preconfigured ST250 V3 customized in CTO mode. Launch stays on
  `/lfos/{code}/as_cto_launch`; derive, summary and export use the CTO family.
- `../software-qty3-import-response.json` and `../service-qty-import-response.json`:
  minimal import envelopes from the earlier generated handoff checked in the
  headless website. The service catalog is reduced to the selected service.
  These test restoration; browser quantity fixtures are the authority for export
  unit-price semantics.
- `storage-network-create.json`: the browser's default unassigned storage
  definition as serialized by its next auto-connect request.
- `storage-network-lifecycle.json`: browser-authoritative create, edit-panel,
  rename and remove behavior. Definition mutations are local state changes with
  no remote request; controller `Edit Item` starts a separate product launch.
- `storage-controller-customization.json`: browser-authoritative ATZV server HBA,
  DM3200F controller selection/launch, and named storage assignment. The
  controller gets a fresh configuration ID, is appended to the full
  rack-customize configuration projection, and the same ID is stored in the
  storage definition. It remains a storage-managed configuration without a
  Summary product card or a synthetic physical rack/non-rack item.
  Assignment runs auto-derive with the name on the server raw configuration;
  no workspace selection map is sent. A captured controller edit changes AV1W
  from quantity two to four through a target-only auto-derive response, then
  returns through switch calculation and rack customize. Both the default and
  edited ATZV plus DM3200F direct-attach attempts ended with empty switch
  calculation and connections, so this fixture does not claim populated storage
  cables. Reopening reuses the configuration ID and selections without another
  launch. Browser export keeps raw controller quantity one while its commercial
  group quantity is zero because it has no physical placement. Removing an
  unassigned configured definition locally cascades the managed configuration
  and its groups; assigned-definition removal remains an explicit evidence gap.
- `network-settings-export.json`: the real browser export location for edited
  auto-connect toggles and storage definitions. Auto-connect toggles are under
  `customizingFlags`; `networkingInformation` contains the persisted network,
  storage, power, cable and switch-map state.
- `browser-auto-switch-cabling.json`: a populated Management graph from the
  complete browser workflow. Automatic switch orchestration launches and adds
  a distinct SN2201, records its generated ID in `switchMap`, and P2P cabling
  connects the server management port to that generated switch with AVFT.
- `switch-provisioning.json`: sanitized `/switch_calculation` workspace and
  response, SN2201 launch projection, generated configuration/rack/switch-map
  identity contract, authoritative placement correction, partial derive patch,
  and the complete endpoint sequence that produced the populated graph.
- `racked-clone-multiple.json`: sanitized fresh-browser `Clone Multiple`
  contract for one direct, rule-free SR630 V3 in a 42U rack. The staged clone
  changes only identity, position, and `newHardware`; auto-derive groups source
  and clone under the source identity. The browser export keeps distinct raw
  configurations but collapses commercial products under the source: hardware
  price and quantity are extended, while HIPO/service prices stay per
  configuration and their quantities are summed. It does not claim `Copy`,
  non-rack, nested chassis/VLH, or placement-rule semantics.
- `racked-copy.json`: sanitized fresh-browser `Copy` request and export contract
  from `artifacts/implementation-2026-10-15/rack-copy-browser-fresh-run5`.
  A direct SR630 copy is placed in the first available U with a fresh identity,
  `newHardware: true`, and a `Copy_`-prefixed name. Source and copy remain
  separate singleton dependency and commercial groups. Linked, nested and
  placement-rule Copy behavior is not represented.
- `rack-lock-contract.json`: sanitized direct item and empty-U Lock contract
  from `artifacts/implementation-2026-10-15/rack-lock-browser-run2`. Customize
  sends one-based `lockedSpace` (`42` for U42); the subsequent SPA derive and
  export `workspaceInformation.rackData` use zero-based `41`. Export hierarchy
  remains canonical one-based and emits placement feature `3242`. Item `lock`
  remains `true` in every projection. The export request retained both locks;
  its response timed out, so ZIP reimport remains a separate gate.
- `rack-power-multi.json`: sanitized from
  `artifacts/implementation-2026-10-15/rack-power-multi-browser-run2`.
  The rack accepts and round-trips two PDU codes and two line-cord codes with
  independent non-unit quantities. Its raw catalog sections say
  `singleEntry:false` while the compact request sections continue to serialize
  `multipleSelectable:false`.
- `linked-clone-cpu-response.json`: sanitized from the fresh-browser
  source-initiated BYW3 quantity-one to quantity-two edit in
  `artifacts/implementation-2026-10-15/rack-clone-linked-cpu-source-run1`.
  The full request carries both edited clone configurations in
  `customizingIds`; DCSC returns only the initiating source and explicitly
  identifies both fan-out targets in `updateConfigurationIds`. The compact
  fixture preserves that response identity, selection, price, and target-list
  contract without retaining dynamic browser IDs. A separate member-initiated
  capture in `rack-clone-linked-cpu-member-run1` clicked the U2 clone, but the
  SPA opened and posted the root configuration; the root remained the sole
  response identity and both members settled to the same selection and price.
- `linked-clone-root-delete.json`: sanitized from the fresh-browser
  three-member Clone Multiple deletion in
  `artifacts/implementation-2026-10-15/rack-clone-browser-delete-root-three-run2`.
  Deleting the original root promotes the first surviving member, retains the
  remaining two members as one linked dependency group, and exports their
  hardware under that promoted identity with quantity two.

- `storage-network-create.json`: unassigned headless Add Storage default, serialized by the subsequent auto-connect request. The controller has no expansions, but the stored maximum defaults to one.
- `network-settings-export.json`: browser Export Save flag placement and network envelope keys. Automatic PDU/switch/P2P toggles are export customizing flags; runtime autoConnectSettings is not a networkingInformation export field.
- `storage-controller-customization.json` also records a fresh-browser
  differential of the website's own configured-controller XML and the MCP
  managed-controller XML. Both import with HTTP 200, retain the storage
  definition and identical zero-quantity controller HW/HIPO commercial rows,
  and omit the controller from hydrated configurations, Summary cards and
  physical placement. Both source exports are unassigned with an empty graph,
  so this comparison does not test assignment or cable-graph preservation.
- `xml/storage-managed-controller.xml` is the byte-for-byte website export used
  as that differential's oracle. It is an anonymous AI/HPC rack, server and
  configured DM3200F controller export; its embedded checksum is intentionally
  preserved. `scripts/parity-storage-reimport.ts` uses it by default and needs
  only `--mcp-xml` plus an optional output directory.
- `storage-controller-customization.json` includes the selected DB710S SAN
  switch lifecycle. Editing launches `7DHNCTO1WW`, retains selected base feature
  `C1FM`, appends a managed compact switch configuration, and stores its ID only
  in the storage definition. It creates no physical item and no `switchMap`
  entry. The captured DM3200F + DB710S + ATZV assigned and racked combination
  still produced an empty switch calculation/customize graph and never reached
  cabling `auto_connect`; it is recorded as a rejected compatibility candidate,
  not as populated storage-cabling support.
- The SAN fixture also records DB710S reopen/export/removal ownership. Reopen
  reuses the managed switch without another launch. Browser export keeps raw
  controller/switch quantity one while projecting both HW groups at quantity
  zero; the DS controller also has a zero-quantity HIPO row, while the DB710S
  has no service/HIPO rows. Removing the only unassigned definition locally
  drops both exclusively referenced managed configurations and their groups,
  although the contemporaneous rack-customize request still carries the old
  state. Shared-component ownership is not established. The earlier C4A8 Fibre
  adapter probe searched for quantity 1 even though the live control only offers
  0, 2, 4 and 6. Its page/target closure was an automation defect and is not
  evidence of an upstream interruption or unsupported feature. A valid quantity-2
  derive now returns eight `sourceFeature: C4A8` controller ports whose 1/10/25
  GbE Fibre topologies overlap the two ATZV server ports and DB710S. Run 47
  placed and assigned all three products, then exercised the exact P2P-enable
  trigger: `/api/auto_connect` and its follow-up derive both returned 200, but
  the graph still contained only the existing Management link and no storage
  links. This rejects that exact ATZV/C4A8/DB710S combination as a populated
  graph fixture; a different website-supported product combination remains the
  explicit nonempty storage-cabling gate.
  Run 49 added B4B3 32Gb controller optics quantity eight and replaced the server HBA with BJ3H 32Gb dual-port quantity one. The accepted compact and physical feature snapshots contained both choices and no ATZV, but auto-connect again returned only Management. Run 50 then identified two different C4AC controls: the `CLUSTER_ADAPTER` control carries the selected quantity two while the `NETWORK_ADAPTER` control is already zero. The selected control offers only quantities one through eight, so the captured BF3C bundle cannot remove its mandatory Ethernet adapters through Guided mode. A different controller bundle or a verified Expert-mode path is required before another FC auto-connect attempt.
  Run 48 then verifies a post-placement DB710S `C1FP` quantity-one edit: the editor derive returns distinct template-target and physical-alias price variants, and Back to Workspace performs switch calculation, rack customization and a workspace derive before export. Changing that configured SAN selector to Direct Attached only clears the definition's `mainSwitch` option/feature/id; the browser retains the old DB710S template, physical alias, feature selection and dependency. Its export consequently counts the detached template plus physical alias at hardware/service quantity two. This is verified identity and commercial behavior; the capture had no storage links, so cable-graph replacement remains untested.
- `storage-physical-placement.json` records the separate rack action required
  after controller/SAN-switch templates are configured. The rack empty-U menu
  exposes `+ Storage Network` only after the Automated Rack PDU blocker is
  resolved. First placement launches missing DS3200 and DB710S templates, then
  creates distinct physical IDs while keeping the template IDs in
  `storageConnectionNetworks` and the customize `configurations` array.
  `cloneDependency` maps each template to its physical alias. Repeated
  placement performs no launch, creates another physical pair, and appends the
  new aliases without replacing the first pair. DCSC authoritatively supplies
  size, quantity zero and final rack positions. Browser export keeps each
  managed template configuration at quantity one, but projects controller and
  SAN-switch hardware, HIPO and service quantities from the physical alias
  count. Hardware `price` is extended; the captured child rows keep their
  one-placement price fields while their quantities scale. Expansion placement
  remains a separate evidence gate. The immediate repeated-placement export is
  not an editable round-trip oracle: the second customize response returned
  arranged, sized items, but the browser export retained the new aliases at
  requested U1 with null size. Website-own import returned HTTP 200 yet showed
  an empty $0 Summary with Workspace disabled; it dropped managed template raw
  configurations while retaining groups, storage options and dependency
  colors. MCP import must not invent editable templates from that compact data.
- `storage-alias-move.json` records the native Summary move after two physical
  placements. The grouped controller action moves both controller aliases and
  posts auto-derive without `entranceFlag` or `customizingIds`. Its response
  targets physical aliases through `updateConfigurationIds` while keeping the
  editable controller and SAN-switch templates distinct. The exported compact
  configurations remain template-only, but commercial prices reflect the
  physical derived variants. `storage-physical-derive.json` keeps the focused
  DS3200 and DB710S response fields used to verify that split and future-field
  preservation.
- `storage-postplacement-edit.json` records an option change after physical
  placement. The controller editor posts both the physical alias and editable
  template in `customizingIds`; auto-derive returns separate B6Y7 physical and
  B6Y6 template variants. Back to Workspace then runs switch calculation and
  rack customization with C4A8 quantity two copied into both the compact
  template and physical rack feature snapshot. The retained connection is an
  existing Management link, so storage cabling remains unproved.
- `storage-fc-zero-graph.json` records the strongest anonymous FC storage
  auto-connect attempt without overstating its result. The website accepted a
  DE2000H controller with the Fibre Channel persona (`B4DA`), eight 16Gb FC
  transceivers (`B4B2`), two 16Gb FC adapters (`B4B7`), an assigned SR630 V3
  with `ATZV`, and a DB610S SAN switch. The final `/api/auto_connect` request
  contained the named storage definition and the server's
  `selectedStorageNetwork`; it returned HTTP 200 with no errors, but generated
  zero storage rows. Its sole connection was the pre-existing 1GbE Management
  link. The SAN switch exposes no `cableCompatible` group and sets
  `useCableAsDAC: true`, while the server and controller expose cable groups.
  The maintained Direct Attached isolation then imported the same settled
  export, verified every FC selection and the server assignment, cleared the
  SAN switch through the native UI, and sent another complete P2P request.
  That request also returned HTTP 200 with no errors and only the existing
  Management row. Populated FC storage cabling therefore remains an explicit
  anonymous website/backend limitation for this captured catalog; this fixture
  is not evidence of populated FC cabling or MCP graph parity.
- `xml/storage-fc-zero-graph.xml` is the byte-for-byte anonymous website export
  from that same settled run. Its embedded checksum is intentionally preserved.
  `scripts/parity-storage-fc.ts` uses it by default, changes only the named
  definition to Direct Attached, and exits 2 when the native HTTP-200 response
  still has no storage row. Pass `--out`; `--xml` is available for another
  captured producer without making ignored artifacts a release prerequisite.
- `storage-expansion-catalog-gate.json` records the current anonymous expansion
  prerequisite. Fresh General Purpose and AI/HPC storage-preference responses
  each contain 31 controllers but no `controllers[].expansions[]` entries. The
  headless UI consequently shows `Select an Option` and `max: 0`. The fixture
  preserves the SPA's selection and quantity rules, but leaves launch,
  placement, commercial and ownership semantics explicitly unestablished until
  the live catalog returns a controller-linked expansion descriptor.
- `nested-removal-contracts.json` is the sanitized structural oracle from the
  maintained native D3/SD535 removal captures on 2026-10-16. It records the
  exact customize/derive sequence and configuration, dependency and physical
  disposition for deleting a populated chassis, deleting only its nested node,
  and moving that node to Non Rack. The authoritative evidence directories are
  named in the fixture. Earlier `node-run1` artifacts clicked the parent
  chassis and are deliberately excluded. Native Delete Node keeps the copied
  node's commercial configuration but omits it from physical areas and clone
  dependencies; importing that native XML consequently restores three of the
  four configurations. This website round-trip loss is part of the captured
  contract rather than evidence that Delete Node removes its quote line.
- `xml/nested-detached-browser.xml` is the byte-for-byte native Delete Node
  export from that capture (SHA-256
  `76cece6589c52bf569354e246e86a19dc4739059e6319600bfe41f6985a1f5c4`).
  It contains four commercial configurations but three clone-dependency roots;
  website import accepts it and restores three editable configurations.
- Native import of `xml/nested-racked-browser.xml` returns the nested node in
  `workspace.rackArea[].children[].children[]` with `size: 1`, while the
  corresponding floor-grid chassis has no `nodes` collection. The website
  forwards that slim hierarchy to rack customization, which assigns
  `occupiedBay: 1`; the import hydrator follows that captured fallback only
  when the complete physical node-location list is absent.
