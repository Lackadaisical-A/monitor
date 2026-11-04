"""Build the app's teaching library from the reviewed workbook export.

Input is private build material, never a runtime spreadsheet dependency.
Stable source codes identify competencies; copy edits never identify progress.
"""
import json, re, sys
from pathlib import Path

source = json.loads(Path(sys.argv[1]).read_text())
out = Path(__file__).resolve().parents[1] / 'ios/BiotechSignal/Academy/Resources/academy-lessons.json'
sheet = 'https://docs.google.com/spreadsheets/d/16ILxYXGkIKVgvaMjodYdQrtpCopZKnLh/edit'

# These are rewritten for Onshape, not product-name substitutions in Fusion steps.
design = [
 ('Sketches, solids and cutouts', 'Create a dimensioned part using sketches, additive extrudes, and material removal.', ['Create a document and Part Studio. Set units to millimeters, select the Top plane, and sketch a rectangle with two dimensions.', 'Extrude the closed region to create a solid. Sketch a circle on a face and use Extrude Remove to cut a hole.', 'Edit the original sketch dimension and verify that the solid rebuilds. Rename the sketch and both features.', 'Build a second original part with a cutout. Explain which feature adds material and which removes it.']),
 ('Planes, dimensions and placement', 'Position geometry accurately using sketch planes, dimensions, alignment, and symmetry.', ['Identify the origin and the three default planes. Choose a plane that suits the intended view of your part.', 'Locate a hole using dimensions from the origin. Use constraints instead of estimating its position by eye.', 'Mirror sketch geometry across a construction centerline and explain how symmetry is preserved.', 'Change a dimension and inspect the resulting geometry from front, top, and isometric views.']),
 ('Your first Onshape print', 'Prepare, export, print, and evaluate an original Onshape part.', ['Check the model dimensions, wall thickness, and orientation against the intended printer and material.', 'Export the selected part as an STL in millimeters. Open it in the slicer and confirm that its size is correct.', 'Inspect the layer preview for unsupported features and request instructor approval before printing.', 'Measure the finished part, compare it with the design, and document one revision before producing the next version.']),
 ('Design a nameplate', 'Create readable raised or recessed lettering on a printable part.', ['Sketch and dimension a base plate with suitable edge margins.', 'Add sketch text on the plate face. Extrude Add for raised text or Extrude Remove for recessed text.', 'Check the smallest letter strokes and depth in the slicer preview; adjust features that will not print clearly.', 'Print a test and assess readability, strength, and edge finish. Save a named version of the revised document.']),
 ('Adapt an existing design', 'Modify a reusable design for a measured need while preserving attribution.', ['Choose an Onshape document or editable CAD file whose license permits the intended reuse. Record its source.', 'Measure the required interfaces and make a copy or import the editable geometry into a new document.', 'Modify the necessary features and verify the fit. An imported mesh is a reference, not an editable feature history.', 'Document your changes and the original creator. Share an appropriate view link and a print-ready export.']),
 ('Parametric design in Onshape', 'Build a model that can be revised predictably using named features and variables.', ['Identify the Part Studio, origin planes, Feature list, parts list, and view controls. Explain what each contains.', 'Sketch a 40 by 20 mm rectangle and extrude it 10 mm. Edit 40 to 70 mm and verify the rebuilt solid.', 'Create a length variable named wall before the features that use it. Use #wall in two dimensions, then change its value and check both results.', 'Build and name at least six features. Have a partner explain the model by reading the Feature list from top to bottom.']),
 ('From drawing to prototype', 'Translate a dimensioned concept into a constrained model and physical prototype.', ['Draw the part on paper, label critical dimensions, and identify the surfaces that must fit another part.', 'Create a sketch on a suitable plane, dimension its outline, and extrude a solid.', 'Use additional sketches with additive and subtractive features to form the functional details.', 'Export and print a prototype, measure the interfaces, and revise the model based on the results.']),
 ('Constrain a sketch', 'Use dimensions and geometric constraints to express design intent.', ['Create a sketch and identify geometry that can still move by dragging it.', 'Apply coincident, horizontal, vertical, and dimensional constraints where they express the intended design.', 'Use symmetry or equal constraints for matching features. Remove conflicting constraints without changing the intended shape.', 'Demonstrate a fully constrained sketch and change a controlling dimension to verify predictable behavior.']),
 ('Fillets, chamfers and shells', 'Design a practical enclosure with controlled wall thickness and edge treatments.', ['Create a solid enclosure blank and identify the faces and edges that serve its function.', 'Apply Shell to establish the wall thickness and remove the opening face.', 'Compare fillets and chamfers on appropriate edges. Inspect whether their size interferes with nearby features.', 'Reorder or edit a feature, resolve the earliest failing feature, and inspect the slicer preview for a printable result.']),
 ('Revolves, sweeps and lofts', 'Choose suitable features for rotational, path-based, and changing-section forms.', ['Sketch a closed profile and a construction axis, then use Revolve to make a rotational part.', 'Create a profile and path for a Sweep. Check the orientation and tight bends.', 'Create profiles on separate planes and use Loft to connect them. Inspect the transition for unwanted twisting.', 'Compare the three methods and choose one for an original handle, fairing, or adapter. Explain the choice.']),
 ('Dimensions and fit', 'Use measured clearances to design parts that fit together reliably.', ['Measure the same feature several times and record units, tool resolution, and the range of readings.', 'Design a clearance test coupon with labeled variations. Print it using the intended process.', 'Select a clearance from the test results and apply it to the mating geometry using a named variable.', 'Assemble the parts, record the fit, and distinguish model dimensions from the dimensions of the printed result.']),
 ('Design for manufacturing', 'Adapt geometry to the limits of the intended printer and material.', ['Choose an orientation and identify overhangs, bridges, thin walls, and stressed directions.', 'Revise geometry to reduce support demand without compromising its function.', 'Check wall widths, holes, and small details in the layer preview with the intended printer profile.', 'Print and evaluate the part. Record orientation, material, relevant settings, and the revision needed.']),
 ('Assemblies that move', 'Model a mechanism with intentional motion and realistic clearances.', ['Create separate parts with measured interfaces and insert them into an Assembly.', 'Fix a reference part and use mate connectors to position the remaining parts.', 'Apply Fastened, Revolute, or Slider mates according to the intended motion. Set appropriate limits.', 'Animate the mate, inspect interference through its travel, and test a printed prototype against the intended motion.']),
 ('Engineering drawings', 'Communicate a design so another person can manufacture and inspect it.', ['Create an Onshape Drawing from the intended part or version using the appropriate units.', 'Add aligned orthographic views and an isometric view where it helps explain the shape.', 'Dimension the manufacturing features without duplicating dimensions. Add necessary tolerances and notes.', 'Have a partner identify every critical measurement from the drawing. Correct omissions and export the drawing as a PDF.']),
 ('Design to a brief', 'Take an agreed need through requirements, prototypes, testing, and delivery.', ['Agree on the purpose, users, constraints, and measurable acceptance criteria before modeling.', 'Present dimensioned concepts and record the selected approach and tradeoffs.', 'Build an Onshape model, make a prototype, and observe a user testing it against the brief.', 'Revise the design from evidence and deliver the model, drawing, manufacturing files, and a concise test record.'])
]
design_criteria = [
 ['A dimensioned sketch is created on the intended plane in a named Part Studio.', 'A solid contains both an additive feature and a clean through-cut.', 'Changing the controlling dimension rebuilds the intended geometry without errors.', 'An original second part demonstrates the difference between adding and removing material.'],
 ['The origin, default planes, and chosen sketch plane are correctly identified.', 'A hole is located using dimensions rather than visual placement.', 'Mirrored geometry remains symmetric when a controlling dimension changes.', 'The revised geometry is correctly inspected in three views.'],
 ['Dimensions, wall thickness, and orientation suit the selected manufacturing process.', 'The exported STL opens at the intended size in the slicer.', 'The layer preview is explained and the instructor approves the print.', 'Measurements of the print support a documented design improvement.'],
 ['The base has stated dimensions and sufficient margins around the lettering.', 'Raised or recessed lettering is correctly modeled with an appropriate extrusion.', 'Letter strokes and depth remain printable in the layer preview.', 'The printed test is evaluated and an improved document version is saved.'],
 ['The source and permission to reuse the design are documented.', 'The editable copy or import has measured interfaces and appropriate units.', 'Modified features satisfy the measured fit requirement.', 'The handover credits the original creator and includes usable design and manufacturing files.'],
 ['The student identifies and explains the main Part Studio areas.', 'The original 40 × 20 × 10 mm part correctly rebuilds to 70 × 20 × 10 mm.', 'Changing #wall updates two dependent dimensions as intended.', 'A partner can follow at least six clearly named features in the model history.'],
 ['A sketch identifies critical dimensions and mating surfaces.', 'The primary sketch is constrained and produces the intended solid.', 'Additional features create the functional details without unresolved errors.', 'Prototype measurements lead to a justified model revision.'],
 ['Remaining sketch freedom is identified through a controlled drag test.', 'Constraints express the intended relationships without unnecessary restrictions.', 'Conflicts are resolved while retaining the required symmetry or equality.', 'A fully constrained sketch changes predictably when its controlling dimension is edited.'],
 ['The enclosure blank has the intended external form and function.', 'The shell has the specified wall thickness and opening.', 'Edge treatments do not interfere with functional geometry.', 'The Feature list rebuilds successfully and the slicer preview is reviewed.'],
 ['A correct rotational part is produced from a profile and axis.', 'A sweep follows the intended path without unwanted twisting.', 'A loft joins the intended sections with a suitable transition.', 'The chosen method is justified for an original functional form.'],
 ['Repeated measurements include units, tool resolution, and observed variation.', 'The printed coupon clearly identifies each tested clearance.', 'The chosen clearance is supported by results and controls the mating geometry.', 'The assembled fit is evaluated against both model and printed measurements.'],
 ['The proposed orientation accounts for overhangs, walls, and loading direction.', 'A design change reduces support demand while preserving function.', 'The layer preview confirms that critical details will be represented.', 'The result is evaluated with material, orientation, settings, and revision recorded.'],
 ['Separate parts have measured interfaces and appear in the Assembly.', 'The reference part and mate connectors locate the assembly as intended.', 'The selected mates allow only the required movement with suitable limits.', 'The motion is inspected and a physical prototype supports the evaluation.'],
 ['A drawing uses the intended part version and units.', 'The views communicate the shape without ambiguity.', 'Dimensions, tolerances, and notes cover the manufacturing requirements.', 'A partner can identify all critical measurements and the PDF export is usable.'],
 ['The brief defines users, constraints, and measurable acceptance criteria.', 'Dimensioned concepts explain the selected approach and its tradeoffs.', 'Prototype testing produces evidence against the agreed brief.', 'The revised handover includes the model, drawing, manufacturing files, and test record.'],
]

def sentence(s):
    return s.strip().rstrip('.') + '.'

def tidy(s):
    s=s.replace('YOU HAVE GOT IT WHEN', 'Success criteria').replace('GET ASSESSED', 'Instructor assessment')
    s=s.replace('Fusion 360', 'Onshape').replace('Fusion', 'Onshape').replace('Tinkercad', 'Onshape').replace('TinkerCAD', 'Onshape')
    s=re.sub(r'\bshop\b', 'workshop', s, flags=re.I)
    return s.strip().replace('A Onshape', 'An Onshape').replace('a Onshape', 'an Onshape')

# App-specific teaching copy. The source workbook remains unchanged.
practice_edits = {
 'SH-01.1': 'Take an instructor-led tour. Locate the exits, fire extinguisher, first aid kit, emergency stops, and cleanup supplies. Repeat the route independently and explain when to alert an instructor.',
 'SH-01.2': 'Prepare for each session with closed shoes, secured hair, fitted clothing, and the required eye protection. Ask an instructor to record your readiness across three consecutive sessions.',
 'SH-01.3': 'Discuss the hazards of soldering equipment, hot printer components, cutting tools, solvents, and batteries. For each example, name a specific hazard, a precaution, and the point at which you would stop and ask for help.',
 'SH-01.4': 'Work through instructor-provided incident scenarios. Practise stopping work, moving clear when safe, and reporting the problem promptly. Do not attempt an unfamiliar repair or hide a mistake.',
 'AT-08.1': 'With power disconnected, arrange the battery, board, and leads in their intended locations using the approved kit instructions. Test the lid without screws. If it needs pressure, stop and correct the obstruction before proceeding.',
 'AT-08.2': 'Select the correct driver and start each screw by hand. Tighten evenly until secure, without forcing the plastic threads. Ask the instructor to inspect the closure before powering the device.',
 'CO-04.1': 'Plan either a branching story with at least eight scenes and three endings, or an instructor-approved light show. Draw every scene and transition before building. Trace each route to confirm it reaches an intended ending.',
 'CO-04.2': 'Build the complete pack from your map and test every route. Invite a new user to find two endings, or watch the complete show, while you observe without prompting. Revise any confusing transition.',
 'CO-08.1': 'Start with a known working example. Change one line, predict its effect, run it, and explain the result. Repeat with three distinct changes, keeping a recoverable working version.',
 'CO-08.2': 'Make a copy of the working program and introduce one small, reversible error. Read the diagnostic message, locate the affected line, explain the cause, and repair it. Run the original behavior again to verify the fix.',
 'CO-12.2': 'Use your planning card as a test checklist. Play from the start through each planned interaction, increasing difficulty, and the ending. Record defects, fix them, and repeat the complete run before exporting.',
 'SP-04.2': 'Use the instructor-approved design and alignment jig to position the fins. Inspect alignment from the rear and check that the assembly stands square. Correct alignment before the adhesive cures.',
 'SP-04.3': 'Inspect the assembly with an inert motor substitute. Check the mount, retention, internal security, and removable nose fit. Report any movement, obstruction, or loose part before the instructor approves the build.',
 'SP-05.1': 'Use the approved flight configuration to locate the loaded center of gravity. Compare it with the design reference and instructor-approved stability requirement. Record the measurement; the instructor makes the launch-readiness decision.',
 'PI-01.1': 'Disconnect power and check the exact controller pinout. Seat the board squarely without bending pins, then have the instructor inspect supply polarity and connections before first power-up.',
 'PI-01.2': 'Trace the complete power route from the supply through the rails to the controller. Label each connection on a drawing and compare it with the board documentation. Check for split rails rather than assuming they are continuous.',
 'PI-02.1': 'Draw separate paths for the controller supply and motor supply using the approved driver documentation. Identify the required ground connections and explain why motor current must not pass through a controller signal pin.',
 'PI-03.1': 'Identify your rover by its configured name. Connect the controller, test a low-speed command in a clear area, disconnect, and reconnect. Confirm the rover stops safely when control is lost.',
 'LI-02.2': 'On the approved Flashlight setup, explore each of the seven documented effects. Compare a fixed color with a moving pattern and explain how the data direction changes the visible sequence. Confirm the hardware and firmware match the lesson first.',
 'CI-03.2': 'Use photographs or instructor-controlled, isolated examples to identify swelling, dents, corrosion, and damaged insulation. Explain how to stop use and report a suspect cell. Students do not handle damaged cells.',
 'CI-03.3': 'With an instructor present, inspect a suitable undamaged rechargeable cell and confirm the manufacturer-specified charger, connector, settings, and charging location. Observe the charge and follow the approved response to unusual heat, swelling, odor, or noise. Record completion and storage arrangements.',
 'CI-03.4': 'Use a circuit simulation or an instructor-selected recording to investigate a short circuit. Explain how low resistance can produce excessive current and heat, and how protection reduces the risk. Do not deliberately short, heat, or touch a warming battery.',
 'PR-11.3': 'Review the academy long-print procedure with the instructor. Record the approved material, profile, monitoring arrangement, first-layer check, and shutdown response. Only the responsible instructor may authorize continued operation. Inspect the completed or stopped job and explain the result from the log.',
 'SP-03.4': 'With the instructor retaining range control, explain the approved launch procedure to another learner. Use a dry rehearsal to check their understanding. Support a supervised launch only after the instructor confirms the site, equipment, and conditions are suitable.',
 'OP-08.3': 'Practise a respectful stop-work intervention in an instructor-led scenario. Explain the concern, notify the responsible staff member, and record the response. A real incident may be discussed if one already occurred; never create an unsafe event for assessment.',
 'OP-08.4': 'Role-play reporting a concern to a more senior person. Use clear, factual language and the academy escalation route. Explain how you would keep people clear while waiting for the responsible instructor.',
}

lessons=[]
for n,row in enumerate(source['skills']):
    code,path,name,tier,kind,summary,unlocks,prereq,count,link,rules=row[:11]
    checks=[c for c in source['checkpoints'] if c[0]==code]
    original=[l for l in source['lessons'] if l[0]==code]
    title=name.lower().capitalize()
    cps=[]
    for c in checks:
        matching=[l[3] for l in original if l[2].startswith('CHECKPOINT '+c[3]+'\n')]
        practice='\n\n'.join(matching).split('YOU HAVE GOT IT WHEN')[0].strip()
        # Keep the precise practical exercise; remove commentary that belongs to the source workshop.
        practice=re.sub(r'\n\n(?:YOU HAVE GOT IT WHEN|GET ASSESSED).*', '', practice, flags=re.S)
        cps.append(dict(id=code+'.'+c[3],title=c[4].lower().capitalize(),practice=tidy(practice),criteria=tidy(c[5])))
    if code.startswith('DE-'):
        title,summary,steps=design[int(code[3:])-1]
        for i,c in enumerate(cps):
            c['practice']=steps[min(i,len(steps)-1)]
            c['criteria']=design_criteria[int(code[3:])-1][i]
            c['title']=['Set up and plan','Model and explain','Test and improve','Demonstrate and document'][min(i,3)]
    # Hardware-neutral CAD guidance in cross-disciplinary projects.
    for c in cps:
        if any(w in c['practice'].lower() for w in ['timeline','change parameters','fusion','tinkercad']):
            c['practice']=f"Use an Onshape Part Studio and named features to complete this task: {c['criteria']} Record dimensions, test the physical result, and save a version before making changes."
        if c['id'] in practice_edits: c['practice'] = practice_edits[c['id']]
        c['practice'] = c['practice'].replace('Tell us', 'Explain to your instructor').replace('tell us', 'explain to your instructor').replace('Show us', 'Show your instructor').replace('show us', 'show your instructor')
    if code == 'CI-03':
        cps[1]['criteria'] = 'Identify damage from safe reference examples and explain how to stop use and report the cell without handling it.'
        cps[3]['criteria'] = 'Explain short-circuit current, heating, and protective measures using a simulation or recording; no live battery fault demonstration.'
    if code == 'PR-11': cps[2]['criteria'] = 'Follow the instructor-approved long-print procedure, record supervision and monitoring, and explain the outcome from evidence.'
    if code == 'OP-08':
        cps[2]['criteria'] = 'Demonstrate and document a respectful stop-work intervention in a scenario or an already-occurring incident.'
        cps[3]['criteria'] = 'Demonstrate the appropriate escalation to a more senior person in a supervised scenario.'
    reference=path in ['ATLAS','CODE','PIONEER']
    lessons.append(dict(id=code,title=title,pathway=path.title(),tier=tier,kind=kind,objective=tidy(summary),
       prerequisites=re.findall(r'[A-Z]{2}-\d{2}',prereq),checkpoints=cps,
       preparation=('Confirm the exact kit, firmware, tools, and supervision with the instructor before starting.' if reference else 'Review prerequisites, collect the tools and materials for the task, and agree on a safe work area with the instructor.'),
       reflection='Explain what you changed, what evidence supports the result, and what you would improve on the next attempt.',
       guidance=tidy(rules) or 'An instructor observes the demonstration and records evidence before awarding this skill.',
       status='Equipment review' if reference else 'Instructor review',
       sourceURL=sheet+link,revision=1,unlocks=tidy(unlocks),
       referenceURL='https://cad.onshape.com/help/' if code.startswith('DE-') else 'https://installatlas.com/academy/'))
    if code.startswith('SP-'):
        lessons[-1]['referenceURL'] = 'https://www.nar.org/ModelRocketSafetyCode'
        lessons[-1]['preparation'] = 'Use only the instructor-approved rocket, launcher, and operating procedure. The responsible instructor checks equipment limits, site permissions, weather, separation, and recovery arrangements before any launch.'
    if code.startswith(('CI-', 'LI-', 'PI-', 'AT-')):
        lessons[-1]['preparation'] = 'Confirm the exact hardware, pinout, voltage, current limits, and manufacturer instructions. Disconnect power before assembly. An instructor checks wiring and battery arrangements before first power-up.'
    if code.startswith('BE-'):
        lessons[-1]['preparation'] = 'Prepare the drawing, measuring tools, suitable scrap, workholding, and required protection. Ask the instructor to approve the tool setup before cutting, drilling, heating, or using adhesives.'
    if code.startswith('DE-'):
        lessons[-1]['preparation'] = 'Open an Onshape document, confirm millimeter units, and prepare the sketch or reference dimensions. Keep a named version before major revisions and ask for a manufacturing review before printing.'
    if code.startswith('PR-'):
        lessons[-1]['preparation'] = 'Confirm the printer, material, slicer profile, and academy operating procedure with the instructor. Prepare a small test when settings or fit are uncertain; obtain approval before starting the machine.'
    if code.startswith('CO-'):
        lessons[-1]['preparation'] = 'Confirm the target device and software version. Save a working copy, define the expected behavior, and prepare a short test checklist before changing code or content.'

catalog=dict(version=2,source='Adapted from the supplied Print and Play Academy workbook for Flight & Aerospace Academy.',skills=lessons)
assert len(lessons)==154
assert sum(len(s['checkpoints']) for s in lessons)==608
assert all(c['practice'] and c['criteria'] for s in lessons for c in s['checkpoints'])
ids={s['id'] for s in lessons}
assert all(set(s['prerequisites'])<=ids for s in lessons)
out.write_text(json.dumps(catalog,ensure_ascii=False,indent=2)+'\n')
print(f'Wrote {len(lessons)} lessons and 608 checkpoints to {out.name}')
