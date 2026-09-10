/** Points must land ON the requested plane and reproject to where they came from. */
import { solveCamera, unprojectPoints, type Segment } from "../../src/camera.ts";
const cr = (a:number[],b:number[])=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const YAW=35*Math.PI/180, TILT=12*Math.PI/180, F=1400, W=1600, H=1200;
const fwd=[Math.sin(YAW)*Math.cos(TILT),Math.sin(TILT),Math.cos(YAW)*Math.cos(TILT)];
const right=[Math.cos(YAW),0,-Math.sin(YAW)];
const up=cr(fwd,right), down=[-up[0],-up[1],-up[2]], C=[0,1.6,-40];
const proj=(P:number[]):[number,number]=>{const d=[P[0]-C[0],P[1]-C[1],P[2]-C[2]];
 const zc=fwd[0]*d[0]+fwd[1]*d[1]+fwd[2]*d[2];
 return [F*(right[0]*d[0]+right[1]*d[1]+right[2]*d[2])/zc+W/2, F*(down[0]*d[0]+down[1]*d[1]+down[2]*d[2])/zc+H/2];};
const seg=(a:number[],b:number[],l:string):Segment=>{const p=proj(a),q=proj(b);return{x0:p[0],y0:p[1],x1:q[0],y1:q[1],label:l}};
const lines=[seg([-10,0,0],[-10,14,0],"vertical"),seg([10,0,0],[10,14,0],"vertical"),seg([10,0,12],[10,14,12],"vertical"),
 seg([-10,2,0],[10,2,0],"eave-x"),seg([-10,14,0],[10,14,0],"eave-x"),seg([-10,8,0],[10,8,0],"eave-x"),
 seg([10,2,0],[10,2,12],"eave-z"),seg([10,14,0],[10,14,12],"eave-z"),seg([10,8,0],[10,8,12],"eave-z")];
const r:any=solveCamera([W,H],lines,{height_m:14});
const cam=r.camera_for_unproject;
const eye:[number,number,number]=[0,r.eye_height.eye_height_m_metric,-r.eye_height.horizontal_distance_m];
const say=(n:string,c:boolean,d="")=>console.log(`${n} | ${c?"PASS":"FAIL"} | ${d}`);

const g=unprojectPoints(cam,{axis:"y",value:0},[proj([-10,0,0]),proj([10,0,0]),proj([10,0,12])],eye);
say("ground points land on y=0", g.world.every(w=>w&&Math.abs(w[1])<1e-6), JSON.stringify(g.world.map(w=>w?.[1])));
say("ground reprojection ~0 px", (g.max_reprojection_error_px ?? 9) < 0.01, `max ${g.max_reprojection_error_px}`);

const base=unprojectPoints(cam,{axis:"y",value:0},[proj([-10,0,0])],eye).world[0]!;
const top=unprojectPoints(cam,{axis:"z",value:base[2]},[proj([-10,14,0])],eye).world[0]!;
say("recovers true 14 m height", Math.abs((top[1]-base[1])-14)<0.05, `got ${(top[1]-base[1]).toFixed(3)}`);

const behind=unprojectPoints(cam,{axis:"z",value:-999},[proj([0,5,0])],eye);
say("refuses a plane behind the camera", behind.world[0]===null, JSON.stringify(behind.notes));
