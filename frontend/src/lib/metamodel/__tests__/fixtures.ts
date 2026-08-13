/** Shared fixture for every yaml-edit suite: comments + flow props + shorthand
 * endpoints + an abstract mapless relationship, i.e. every shape the smart-city
 * metamodel uses. Comment survival is THE contract under test. */
export const FIXTURE = `## smart-city excerpt — file comment must survive
enums:
  Status: [Draft, Active] # inline comment
elements:
  # the abstract root
  - name: NamedElement
    abstract: true
    properties:
      - {name: name, datatype: string, multiplicity: "1", max_length: 200}
    key: [name]
  - name: Zone
    extends: NamedElement
    properties:
      - {name: area, datatype: float, min: 0}
  - name: Building
    extends: NamedElement
relationships:
  - name: Observes
    abstract: true
  - name: Contains
    containment: true
    source: Zone
    target: Building
    source_multiplicity: "1"
  - name: Monitors
    extends: Observes
    source: Building
    target: Zone
    properties:
      - {name: since, datatype: date}
`;
